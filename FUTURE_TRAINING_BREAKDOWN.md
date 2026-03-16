# Future Training Suggestions - Architecture Breakdown

## Overview
The "Future Training" feature generates personalized training recommendations using a multi-stage ML pipeline that analyzes your historical workout data to identify success patterns, predict your training phenotype, and synthesize goal-specific suggestions.

---

## Part 1: Data Collection & Preprocessing

### Source Data
- **Workouts**: Complete ride history with power/HR data, duration, feeling ratings
- **Metrics**: FTP (Functional Threshold Power), max HR, resting HR, body weight
- **Daily Metrics Form**: User-reported feeling strength (1-10 scale per workout)

### Key Preprocessing Functions (`analysis.js`)

#### 1. **calculateTrainingDNA(workouts, metrics, ftp)**
- Analyzes the last **90 days** of workout data
- Groups workouts by **weekly buckets** (12-week rolling window)
- For each week, **classifies workouts** into zones:
  - Recovery, Endurance, Tempo, Threshold, VO2 Max, Anaerobic
- Calculates **rolling 3-week averages** to smooth noise
- **Identifies the "Best Week"**: Highest average feeling score (must have ≥2 workouts)
- Returns trend data for charting and analysis

#### 2. **classifyWorkout(workout, ftp)**
- Maps each workout to a single primary zone based on:
  - Normalized Power (NP) or avg power
  - Intensity Factor (IF) = NP / FTP
  - Duration
  - Heart rate data (fallback if power unavailable)
- Example:
  - IF < 0.75 → Endurance
  - 0.75 ≤ IF < 0.90 → Tempo
  - 0.90 ≤ IF < 1.05 → Threshold
  - IF ≥ 1.05 → VO2 Max / Anaerobic

#### 3. **calculateTimeInZones(streams, ftp)**
- Uses **sub-second power stream data** from FIT files
- Bins each power sample into correct zone (7 zones total)
- Returns **seconds spent in each zone** per ride
- More granular than classification (captures mixed-intensity rides)

---

## Part 2: The ML Intelligence Engine (`intelligence.js`)

### Stage 1: Adaptation Analysis - `analyzeAdaptations(workouts, metrics, ftpHistory)`

**Purpose**: Detect when training stress correlates with performance improvements

**Algorithm**:

1. **Create Weekly Stats Time Series**
   - For each week in workout history:
     - Calculate **TSS (Training Stress Score)**:
       - If power data: `TSS = (Duration_hours × NP × IF) / (FTP × 36)`
       - If power missing: Estimates from HR using critical heart rate
     - Calculate **Volume** (total hours)
     - Extract **Performance Peaks**: 1-min, 5-min, 20-min power maxima
     - Average **Feeling Score** for the week

2. **Identify "Success Blocks"** (4-6 week periods of improvement)
   - Compare performance metric (e.g., 20-min power) **now vs 4 weeks ago**
   - Threshold: **≥1.5% improvement** counts as success
   - Check: Volume growth >5% **OR** high stress with positive feeling
   
3. **Classify Adaptation Type**
   - **Stress Adaptation**: You improved despite (or because of) high TSS
   - **Recovery Adaptation**: You improved while TSS *decreased* (20%+ drop)
   - A recovery adaptation suggests your body responds better to quality over quantity

4. **Identify Stagnation Zones**
   - High TSS (>300) + low feeling (<6) + no improvement = **Overtraining Risk**
   - Flags: "High Stress with Low Feeling" or "Performance Decline despite Effort"

**Output**: 
```javascript
{
  weeklyStats: [{week data with TSS, volume, performance}],
  adaptations: [{date, type, improvements, avgTss, avgVol, avgFeeling}],
  stagnationZones: [{flags for overtraining risk}]
}
```

---

### Stage 2: Success Pattern Mining

**In FutureTraining.jsx useMemo()**:

1. **Identify "Star Periods"**: 7-day rolling windows where ≥3 workouts had feeling ≥8
2. **Analyze 6-week blocks leading to each star period**
   - Average hours per week
   - Zone distribution (% time in each zone)
3. **Average all star periods** to get a **"Success Profile"**:
   ```javascript
   {
     avgHrs: 7.2,  // hours/week during successful phases
     zDist: [10, 65, 12, 8, 5, 0, 0],  // % in each zone
     count: 3  // number of star periods found
   }
   ```

**This becomes the data-driven baseline for recommendations.**

---

### Stage 3: Zone Distribution Blending - `blendHistoryWithGoal(analysis, goal, avgSuccessVol)`

**Purpose**: Merge three constraints into a single zone prescription

**Inputs**:
1. **Historical Pattern** (from success blocks)
   - If you succeeded with 65% endurance + 20% threshold → weight this 50%
   
2. **Goal Modifiers** (lookup table)
   - **Endurance Goal**: 70% endurance, 3% VO2
   - **Climbing Goal**: 25% tempo, 25% threshold (sustained power)
   - **Speed Goal**: 20% VO2 max, 10% anaerobic
   - Weight goal: 40%

3. **Base Distribution** (neutral fallback)
   - 50% endurance, 18% tempo, 12% threshold, 8% VO2 max
   - Weight: 10%

**Formula**:
```
Final.endurance = (Historical.endurance × 0.50) 
                + (Goal.endurance × 0.40) 
                + (Base.endurance × 0.10)
```

**Output**: A single zone distribution (e.g., 50.3% endurance, 18.9% tempo, etc.)

---

### Stage 4: Session Planning - `generateSessionPlan(zoneDistribution, availHours, avgSuccessVol, daysAvailable)`

**Purpose**: Convert zone percentages into a realistic weekly schedule

**Algorithm**:

1. **Safety Check: 10% Progressive Overload Rule**
   - Calculate recent 4-week average volume
   - Cap new plan at: `min(requestedHours, recentAvg × 1.10)`
   - Flags warning if user is asking for too much too soon

2. **Session Allocation**
   - Recovery: ~0.75 hrs/session, 1× per week
   - Endurance: ~1.5-2 hrs/session, 1-2× per week
   - Tempo: ~1 hr/session, 1× per week
   - Threshold: ~0.75 hrs/session, 1× per week
   - VO2 Max: ~0.5 hrs/session, 1× per week (if time allows)
   - Anaerobic: ~0.4 hrs/session, 1× per week (only for "Speed" goal)

3. **Day-Count Constraint**
   - If session count exceeds available days:
     - Drop Recovery first
     - Consolidate multiple Endurance → single longer ride
     - Merge smallest intensity session into Endurance
   - Repeat until fits within day limit

**Output**:
```javascript
{
  sessions: [
    { type: "Recovery", count: 1, hoursPerSession: 0.75, totalWeekly: 0.75 },
    { type: "Endurance", count: 2, hoursPerSession: 1.5, totalWeekly: 3.0 },
    ...
  ],
  totalWeeklyHours: 6.5,
  sessionsPerWeek: 5
}
```

---

### Stage 5: Progression Strategy - `determineProgressionStrategy(analysis, availHours, avgSuccessVol)`

**Decision Tree**:

```
IF time-constrained (availHours < 80% of historicalSuccess)
  → Return "Intensity" (focus on high-quality, shorter sessions)
ELSE
  IF user showed better gains from volume than intensity
    → Return "Volume" (build weekly hours)
  ELSE IF user showed better gains from intensity
    → Return "Intensity" (add more high-intensity work)
  ELSE
    → Default: "Volume" (if good time availability)
```

---

### Stage 6: 4-Week Progression Plan - `generateFourWeekPlan(baseWeeklyPlan, analysis, availHours, avgSuccessVol, progressionType)`

**Purpose**: Create a structured 4-week block with periodization

**Pattern** (B-B-P-R = Build-Build-Peak-Recover):

| Week | Volume Multiplier | Focus | Intensity |
|------|-------------------|-------|-----------|
| 1    | 1.00x base        | Base Fitness | 100% |
| 2    | 1.10x base        | Progressive Load | 100% |
| 3    | 1.15x base        | Peak Week | 105% (intensity mode) |
| 4    | 0.80x base        | Recovery & Adaptation | 85% |

**If Volume Progression**:
- Week 1 → 2: +10% duration
- Week 2 → 3: +15% duration (peak)
- Week 3 → 4: -20% duration (recovery)

**If Intensity Progression**:
- Keep volume stable
- Weeks 1-2: Standard intensity focus
- Week 3: +5% intensity (harder intervals)
- Week 4: -15% intensity (easy recovery)

**Output**:
```javascript
{
  weeks: [
    { weekNumber: 1, sessions: [...], totalWeeklyHours: 6.0, focus: "Base Building" },
    { weekNumber: 2, sessions: [...], totalWeeklyHours: 6.6, focus: "Progressive Load" },
    { weekNumber: 3, sessions: [...], totalWeeklyHours: 6.9, focus: "Peak Week" },
    { weekNumber: 4, sessions: [...], totalWeeklyHours: 5.5, focus: "Recovery & Adaptation" }
  ],
  progressionType: "Volume",
  totalPlanHours: 25.0,
  rationale: "Progressive volume increase..."
}
```

---

## Part 3: Recommendation Synthesis - `generateRecommendation(...)`

### Inputs
1. `analysis`: The full adaptation + success analysis
2. `profile`: User's phenotype (Sprinter, Time Trialist, etc.)
3. `goal`: User-selected target (Endurance, Climbing, Speed, etc.)
4. `availabilityHours`: Max hours per week user can train
5. `daysAvailable`: Preferred training days per week

### Process

1. **Calculate Safe Volume**
   ```
   safeLimit = max(3, recentAvg × 1.10)
   effectiveAvailability = min(requestedHours, safeLimit)
   ```
   - Prevents injury from aggressive volume jumps

2. **Blend Zones** using `blendHistoryWithGoal()`
   - 50% historical success + 40% goal + 10% base

3. **Generate Session Plan** using `generateSessionPlan()`
   - Respects day constraints
   - Returns realistic weekly structure

4. **Determine Progression** using `determineProgressionStrategy()`
   - Choose Volume vs Intensity based on history + time

5. **Build 4-Week Block** using `generateFourWeekPlan()`
   - Week 1-3 progressive load
   - Week 4 recovery

6. **Generate Narrative Advice**
   - **Safety warnings**: If volume capped
   - **Time constraint note**: If forced to intensity-focus
   - **Historical insight**: "Your physiology responds to volume" or "You're intensity-responder"
   - **Goal strategy**: Phenotype-specific guidance (e.g., "Sprinter doing climbing: focus on TTE at threshold")
   - **Overtraining alerts**: Flags historical stagnation zones as risks

### Output
```javascript
{
  title: "Proven Formula Refined",
  description: "Narrative advice with safety notes and strategic guidance",
  focusZones: [
    { name: "Endurance", value: 50, color: "#3b82f6" },
    { name: "Tempo", value: 20, color: "#22c55e" },
    ...
  ],
  weeklyPlan: { sessions: [...], totalWeeklyHours: 6.5, ... },
  fourWeekPlan: { weeks: [...], progressionType: "Volume", ... }
}
```

---

## Part 4: Rendering in UI (FutureTraining.jsx)

The React component:

1. **Loads Data**:
   - Fetches all workouts + metrics from IndexedDB
   - Calls `calculateTrainingDNA()` → displays 12-week trend chart
   - Calls `analyzeAdaptations()` → powers the intelligence model

2. **Identifies Success Profile**:
   - Scans for "Star Periods" (high-feeling weeks)
   - Averages 6-week blocks leading to each star
   - Shows "Success Profile" with avg hours + zone distribution

3. **User Input**:
   - Training goal (dropdown)
   - Available hours per week (slider)
   - Days per week available (input)

4. **On "Generate Plan" Click**:
   - Calls `generateRecommendation(analysis, profile, goal, availHours, daysAvailable)`
   - Receives structured recommendation object
   - Renders:
     - Title + description (narrative)
     - Focus Zones pie chart
     - Weekly session plan table
     - 4-week progression timeline chart

---

## ML Model Summary

**What's Not ML, What Is**:

| Component | Type | Method |
|-----------|------|--------|
| Zone classification | Rules-based | Power/HR thresholds + IF formula |
| Success detection | ML-ish | Time-series analysis + threshold detection |
| Phenotype identification | Heuristic | Pattern matching on adaptation history |
| Zone blending | Statistical | Weighted averaging (50-40-10) |
| Session planning | Heuristic | Constraint satisfaction problem |
| Progression strategy | Decision tree | Rule-based branching on history |
| 4-week periodization | Fixed pattern | Standard sports science template (B-B-P-R) |

**The "ML" aspect** is really **adaptive optimization**:
- Detects what *worked for you historically* (success blocks)
- Detects what *didn't work* (stagnation)
- Blends that evidence with your goal + time
- Outputs a personalized plan tailored to your physiology

It's **not** a deep neural network—it's **signal processing + expert heuristics**, but it's data-driven and personalized to your unique response patterns.

---

## Safety Mechanisms

1. **10% Progressive Overload Rule**: Never jump >10% volume week-to-week
2. **Stagnation Detection**: Flags zones where TSS is too high relative to feeling
3. **Time Constraint Graceful Degradation**: Converts to intensity focus if time-limited
4. **Day Limit Override**: Consolidates sessions to fit your schedule
5. **Insufficient Data Fallback**: Returns generic plan if <20 workouts logged

---

## Data Flow Diagram (Simplified)

```
[Historical Workouts + Metrics]
            ↓
    [calculateTrainingDNA]
            ↓
    [analyzeAdaptations] ←─────┐
            ↓                   │
    [Detect Success Blocks]    │
            ↓                   │
    [User Inputs: Goal, Hours] │
            ↓                   │
[blendHistoryWithGoal] ←────────┘
            ↓
[generateSessionPlan]
            ↓
[determineProgressionStrategy]
            ↓
[generateFourWeekPlan]
            ↓
        [Output]
    (Title + Plan)
```

---

## Key Takeaway

**The Future Training feature is a personalized training coach that:**

1. **Learns**: Analyzes what *has worked* for you in the past (success patterns)
2. **Detects Risk**: Warns when training volume or intensity appears unsustainable
3. **Adapts**: Adjusts zone focus based on your goal + time constraints
4. **Prescribes**: Outputs a 4-week periodized plan respecting sports science principles
5. **Validates**: Ensures safe progression (≤10% volume increases)

All decisions are **transparent** and **traceable back to your data**—not a black-box neural network.
