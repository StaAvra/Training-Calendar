TRAINING CALENDAR - COMPILED DOCUMENTATION
Generated: 2026-03-19

Included files (in order):
- README.md
- PERFORMANCE_METRICS_AND_ALGORITHMS.md
- FUTURE_TRAINING_BREAKDOWN.md
- FUTURE_RECOMMENDATION_TEXT_BREAKDOWN.md

================================================================================

# SOURCE: README.md
--------------------------------------------------------------------------------
# Training Calendar

Training Calendar is a cycling training analysis app that stores ride history locally, analyzes successful training blocks, and generates future training recommendations from an athlete's own data.

## Core Capabilities

- Import and inspect workouts from Garmin and Strava
- Visualize ride streams, time in zones, and historical trends
- Detect successful and stagnating training blocks
- Generate future training recommendations from historical response patterns
- Classify whether an athlete is responding more to volume, intensity, or a balanced mix
- Track responder shifts over time instead of assuming one permanent profile

## Local ML Recommendation Engine

The future training engine now includes a first-pass local ML layer that trains directly on the athlete's own history.

### What it does

The recommendation engine in src/utils/intelligence.js now uses a lightweight trained model from src/utils/intelligence/mlModel.js to:

- build adaptation blocks from historical successful periods
- extract block features from volume, TSS, density, feeling, and zone mix
- classify the athlete as Volume, Intensity, Balanced, or Mixed
- estimate responder probabilities rather than relying on a single hard-coded branch
- infer the athlete's best historical zone mix
- detect whether responder type has shifted over time

### Why local ML

This project is currently a frontend-first app with local IndexedDB storage, so the model is intentionally lightweight and runs inside the app without external infrastructure.

The current model is a prototype-style tabular learner trained from the athlete's own successful blocks. It is meant to be:

- immediately usable with the current architecture
- interpretable enough to debug
- safe enough to fall back to rules when data is weak

### Current modeling approach

The first model version is prototype-knn-v1 and works like this:

1. Build historical adaptation blocks from successful 4-5 week periods.
2. Derive exact zone distributions from workout streams.
3. Compute features such as volume, TSS, endurance share, high-intensity share, density, and intensity index.
4. Train label prototypes from those blocks.
5. Compare the athlete's current state to those prototypes.
6. Produce responder probabilities, best historical mix, and a recommendation narrative.

This is the first ML step, not the end state. The long-term target is a richer offline-trained model that predicts expected improvement from candidate future training mixes.

## Recommendation Flow

The current future training pipeline is:

1. Analyze historical weekly load and performance changes.
2. Detect successful adaptation blocks and stagnation zones.
3. Train the local responder model from those blocks.
4. Estimate the athlete's current responder profile.
5. Blend historical best mix with the selected goal.
6. Apply safety constraints such as volume caps.
7. Generate a weekly plan, 4-week progression, and narrative explanation.

## Important Product Decisions

- Rider classification is independent of the selected goal.
- Goals modify the final prescription, not the athlete phenotype.
- Responder type is time-varying and should be tracked across history.
- Zone analysis uses workout streams to derive training mix.
- Rule-based logic remains as a safety baseline and fallback.

## Project Structure

- src/pages: primary application screens
- src/components: reusable UI components
- src/utils/analysis.js: physiological metrics, zones, and trend analysis
- src/utils/intelligence.js: recommendation facade and planning logic
- src/utils/intelligence/mlModel.js: local ML responder model
- src/utils/db.js: IndexedDB access layer
- backend/server.js: Garmin and Strava integration backend

## Development

### Install

```bash
npm install
npm --prefix backend install
```

### Run frontend

```bash
npm run dev
```

### Run backend

```bash
npm run backend
```

### Run Electron app in development

```bash
npm run electron:dev
```

### Run tests

```bash
npm test
```

## Testing Notes

The test suite includes unit coverage for:

- physiological calculation helpers
- the local ML responder classification path
- recommendation generation output shape

## Next ML Steps

- persist responder profile snapshots for longitudinal review
- add offline dataset generation for broader model training
- compare local prototype results against a stronger tabular model
- expose confidence and feature contribution data in the UI
- keep hard safety rules outside the model


================================================================================

# SOURCE: PERFORMANCE_METRICS_AND_ALGORITHMS.md
--------------------------------------------------------------------------------
# Training Calendar App: Performance Metrics & Algorithm Documentation

## Overview
This document describes all calculations, performance metrics, and recommendation algorithms used in the Training Calendar app. It's organized by functional area for easy verification.

---

## 1. POWER ZONES & TIME DISTRIBUTION

### 1.1 Power Zone Definitions
Power zones are calculated as percentages of FTP (Functional Threshold Power):

| Zone | Name | Range | Color |
|------|------|-------|-------|
| Z1 | Active Recovery | 0% - 55% FTP | Gray (#888888) |
| Z2 | Endurance | 55% - 75% FTP | Blue (#3b82f6) |
| Z3 | Tempo | 75% - 90% FTP | Green (#22c55e) |
| Z4 | Threshold | 90% - 105% FTP | Yellow (#eab308) |
| Z5 | VO2 Max | 105% - 120% FTP | Orange (#f97316) |
| Z6 | Anaerobic | 120% - 150% FTP | Red (#ef4444) |
| Z7 | Neuromuscular | 150%+ FTP | Purple (#a855f7) |

**Function:** `calculateZones(ftp)`

### 1.2 Time in Zones Calculation
For each power data point in a workout's stream:
1. Read the instantaneous power value
2. Find the zone where `power >= zone.min && power < zone.max`
3. Increment the time counter for that zone by 1 second
4. Return distribution object with cumulative time in each zone

**Function:** `calculateTimeInZones(streams, ftp)`
- Input: Power stream data points and FTP value
- Output: Array of zones with accumulated time in each zone

---

## 2. CRITICAL PERFORMANCE METRICS

### 2.1 Intensity Factor (IF)
**Formula:**
```
IF = NP / FTP
```
Where:
- **NP** = Normalized Power (see section 2.4)
- **FTP** = Functional Threshold Power

**Meaning:** Ratio of the actual effort to your threshold power. Values above 1.0 indicate sustained power above FTP.

**Function:** `calculateIntensityFactor(workout, ftp)`

### 2.2 Training Stress Score (TSS)
**Formula:**
```
TSS = (Duration_seconds × NP × IF) / (FTP × 36)
```

Where:
- **Duration_seconds** = Total elapsed time of the workout
- **NP** = Normalized Power
- **IF** = Intensity Factor
- **FTP** = Functional Threshold Power

**Calculation Steps:**
1. Calculate IF = NP / FTP
2. Calculate TSS = (s × NP × IF) / (FTP × 36)
3. Round to nearest integer

**Meaning:** Quantifies the total training stimulus received. A 1-hour moderate effort (~100 TSS) can be equivalent to 2 hours of easy riding (~50-60 TSS).

**Function:** `calculateTSS(workout, ftp)`

### 2.3 Normalized Power (NP)
**Algorithm (Standard 30-second Rolling Average):**
1. Calculate 30-second rolling average power for entire workout
2. Raise each 30-second average to the 4th power
3. Calculate the mean of all 4th-power values
4. Take the 4th root of the mean

**Formula:**
```
NP = (Average(avg_30s^4))^(1/4)
```

**Purpose:** Accounts for the non-linear relationship between power and physiological effort. A zigzag effort at average power P produces more fatigue than steady power P.

**Function:** `calculateNormalizedPower(streams)`

### 2.4 Efficiency Factor (EF)
**Formula:**
```
EF = NP / Average_Heart_Rate
```

**Criteria for Measurement:**
- Intensity Factor (IF) ≤ 0.75 (Endurance zone effort only)
- Duration ≥ 30 minutes
- Average Heart Rate > 0

**Meaning:** How much power you can produce per heart rate beat. Higher values indicate better aerobic efficiency. Trends in EF show aerobic fitness improvements independent of power gains.

**Usage:** Tracked over time to identify aerobic fitness improvements (recovery rides with lower HR for same power)

---

## 3. FTP ESTIMATION ALGORITHMS

### 3.1 FTP Improvement Detection
**Goal:** Identify when your best recent efforts suggest your FTP should increase.

**Logic:**
1. **Best Ride Check (Primary):**
   - Find longest workout(s) > 20 minutes
   - Check for rides where NP > Current FTP × 1.05
   - Suggested FTP = Best Power × 0.95

2. **Threshold Ride Check (Secondary):**
   - Find rides with sustained duration > 10 minutes
   - Average power > current FTP
   - Average HR < Critical HR (estimated lactate-threshold HR). If Critical HR is not available, use a conservative fallback (e.g. ~90% of reported `maxHr`). This replaces the previous hard-coded `175 bpm` threshold to account for athlete-specific physiology.
   - Suggested FTP = Sustained average power

**Function:** `checkFtpImprovement(workouts, currentFtp)`
- Returns: `{ suggestedUpdate, reason }` or `null`

### 3.2 Critical Power Model (Monod & Scherrer)
**Two-Parameter Model:**
```
Work = CP × Time + W'
```

Where:
- **CP** = Critical Power (the power you could theoretically sustain indefinitely)
- **W'** = Anaerobic Work Capacity (in Joules)

**Calculation Method (using 3-min and 20-min data):**
1. Get best 3-minute power: `P_3m`
2. Get best 20-minute power: `P_20m`
3. Calculate work: `Work_3m = P_3m × 180s`, `Work_20m = P_20m × 1200s`
4. Calculate CP: `CP = (Work_20m - Work_3m) / (1200s - 180s)`
5. Calculate W': `W' = Work_3m - (CP × 180s)`

**Estimated Accuracy Range:** ±19 to +33 W vs actual CP

**Function:** `calculateCriticalPower(powerCurve)`
- Returns: `{ cp, low, high, w_prime }`

### 3.3 Critical Heart Rate Model
**Analogous to Critical Power:**
```
TotalBeats = CHR × Time + H'
```

Where:
- **CHR** = Critical Heart Rate (HR at threshold)
- **H'** = Heart Rate Reserve above CHR

**Calculation (using 3-min and 20-min HR data):**
1. Get best 3-minute avg HR: `HR_3m`
2. Get best 20-minute avg HR: `HR_20m`
3. Convert to total beats: `Beats_3m = HR_3m × 3 min`, `Beats_20m = HR_20m × 20 min`
4. Calculate CHR: `CHR = (Beats_20m - Beats_3m) / (20 - 3) min`
5. Calculate H': `H' = Beats_3m - (CHR × 3 min)`

**Function:** `calculateCriticalHeartRate(hrCurve)`
- Returns: `{ chr, h_prime }`

### 3.4 Session-Derived FTP (eFTP)
**Purpose:** Estimate FTP from a single workout with minimal cardiac drift.

**Conditions:**
1. Workout duration > 1 hour AND TSS > 70
2. Target interval ≥ 8 minutes long
3. Interval is in the last 40% of the workout
4. HR drift in last 3 minutes of interval ≤ 4%

**Calculation:**
1. Scan workout for 8-minute blocks in last 40% of duration
2. For each candidate interval, check HR drift:
   - `HR_drift = (HR_end3m - HR_start3m) / HR_start3m`
   - Only accept if drift ≤ 0.04 (4%)
3. Return the strongest qualifying interval and use its average power as the FTP estimate

**Function:** `calculateSessionDerivedFtp(workouts)`
- Returns: `{ low, high, avg }` or `null`

### 3.5 Estimated FTP (from Power Curve)
**Purpose:** Estimate FTP based on best efforts at different durations with phenotype adjustments.

**Phenotype-Based Multipliers:**

For each duration (5m, 8m, 20m), use different multipliers depending on athlete type:

| Duration | Base Multiplier | Sprinter Bias | Puncheur Bias | TT/Climber Bias |
|----------|-----------------|----------------|---------------|-----------------|
| 5-min | 0.80-0.82 | +0.05 to +0.10 | +0.02 to +0.06 | -0.02 to +0.02 |
| 8-min | 0.90-0.92 | +0.03 to +0.07 | +0.01 to +0.05 | -0.01 to +0.03 |
| 20-min | 0.95 | +0.02 to +0.05 | -0.01 to +0.03 | -0.03 to +0.01 |

**Formula:**
```
FTP_low = (Power × Base_Min) / (1 + Bias_Max)
FTP_high = (Power × Base_Max) / (1 + Bias_Min)
FTP_avg = (FTP_low + FTP_high) / 2
```

**Rationale:**
- Sprinters: Bias upward (their short-power is 20% better than sustained)
- TT/Climbers: Bias slightly downward (they can sustain higher NP but FTP isn't as high)
- Puncheurs: Neutral bias

**Function:** `calculateEstimatedFtp(workouts, phenotype)`
- Returns: `{ avg, low, high }`

### 3.6 Effective FTP Resolution (Priority Order)
When analyzing a workout, the app resolves which FTP to use:

**Priority:**
1. **Imported FTP** (from FIT file timestamp): Most reliable, user-specific
2. **Workout-Derived FTP** (Session eFTP): Single-workout estimate if available
3. **Profile FTP** (Test-based): User's manually set FTP
4. **Critical Power**: CP calculation if present
5. **Default**: 250W fallback

**Function:** `getEffectiveFtp(workout, currentProfileFtp, cp)`

---

## 4. PHENOTYPE ANALYSIS

### 4.1 Athlete Phenotype Classification
**Purpose:** Determine if an athlete is a Sprinter, All-Rounder, or Steady/TT type.

**Calculation Method:**

1. **Extract Key Power Metrics (W/kg):**
   - Sprint: Best 5s power / weight
   - Anaerobic: Best 1m power / weight
   - VO2 Max: Best 5m power / weight
   - Threshold: Best 20m power × 0.95 / weight

2. **Reference Benchmarks (average recreational cyclists):**
   - Sprint: 16 W/kg
   - Anaerobic: 8.5 W/kg
   - VO2 Max: 5.8 W/kg
   - Threshold: 4.5 W/kg

3. **Calculate Relative Scores:**
   ```
   Score_X = Metric_X / Reference_X
   ```

4. **Compare to Athlete's Own Median:**
   ```
   Average_Score = (Score_Sprint + Score_Anaerobic + Score_VO2Max + Score_Threshold) / 4
   ```

5. **Identify Biases:**
   - Anaerobic Bias = (Score_Sprint + Score_Anaerobic) / 2
   - Aerobic Bias = (Score_VO2Max + Score_Threshold) / 2

6. **Phenotype Classification:**
   - If Anaerobic Bias > Aerobic Bias × 1.1 → **Punchy/Sprinter** (adj: -0.02)
   - If Aerobic Bias > Anaerobic Bias × 1.1 → **Steady/TT** (adj: +0.02)
   - Otherwise → **All-Rounder** (adj: 0.00)

7. **Strengths & Weaknesses:**
   - Strongest = highest relative score category
   - Weakest = lowest relative score category

**Function:** `calculatePhenotype(powerCurve, weight)`
- Returns: `{ type, adj, strengths, weaknesses, scores }`

---

## 5. WORKOUT CLASSIFICATION

### 5.1 Primary Classification Logic: Interval Detection
**Purpose:** Categorize a workout as Recovery, Endurance, Tempo, Threshold, VO2Max, or Anaerobic based on the structure of efforts.

**Algorithm (Block-Based Interval Detection):**

1. **Define Work Threshold:** Zone 3 (Tempo) minimum power
2. **Scan for Intervals:**
   - Look for power ≥ work threshold
   - Allow drops below threshold for up to 30 seconds (coasting, corners)
   - End interval if drop > 30 seconds
3. **Calculate Interval Average Power**
4. **Classify by Average Power & Duration:**

| Avg Power | Min Duration | Classification |
|-----------|--------------|-----------------|
| ≥120% FTP (Z6) | 30s - 3min | Anaerobic |
| ≥120% FTP | >3min | VO2 Max |
| 105-120% FTP (Z5) | 2m - 8min | VO2 Max |
| 105-120% FTP | >8min | Threshold |
| 90-105% FTP (Z4) | >8min | Threshold |
| 75-90% FTP (Z3) | >15min | Tempo |

5. **Count Intervals & Calculate Totals**
6. **Apply Classification Priority:**
   - **Priority 1:** ≥5 anaerobic intervals → Anaerobic
   - **Priority 1:** ≥3 VO2 intervals → VO2Max
   - **Priority 2:** ≥2 threshold intervals OR ≥15min threshold time → Threshold
   - **Priority 3:** ≥1 tempo interval OR ≥30min tempo time → Tempo
   - **Priority 4:** Fallback to IF-based classification

### 5.2 Fallback Classification: Intensity Factor (IF)
Used when high-resolution stream data is unavailable:

| IF Range | Classification |
|----------|-----------------|
| < 0.55 | Recovery |
| 0.55 - 0.80 | Endurance |
| 0.80 - 0.88 | Tempo |
| 0.88 - 1.05 | Threshold |
| 1.05 - 1.20 | VO2 Max |
| > 1.20 | Anaerobic |

**Function:** `classifyWorkout(workout, ftp)`
- Returns: One of ["Recovery", "Endurance", "Tempo", "Threshold", "VO2Max", "Anaerobic"]

---

## 6. POWER CURVE & IMPROVEMENT TRACKING

### 6.1 Best Power Curve
**Tracked Durations:**
- 5s, 10s (Sprint)
- 1m, 2m, 3m (Anaerobic)
- 5m, 8m, 10m (VO2 Max)
- 20m, 60m (Threshold/Endurance)

**Calculation:**
- For each duration, track the **highest average power** achieved in any workout
- Durations are aggregated across rolling windows and stored with each workout

**Function:** Auto-calculated from FIT file parsing or stream analysis

### 6.2 Improvement Detection
**Purpose:** Flag when a power metric improves vs. previous best.

**Logic:**
1. Sort workouts chronologically
2. For each workout, compare each power duration against previous bests
3. If current > previous best, calculate delta:
   ```
   Delta = Current - Previous_Best
   ```
4. Only compare efficiency metrics (NP/HR) if:
   - IF ≤ 0.75 (Endurance zone)
   - Duration ≥ 30 minutes
   - HR > 0

5. Return list of improvements with delta and new value

**Function:** `identifyImprovements(workouts)`
- Returns: `{ [workoutId]: [{ label, delta, value }] }`

---

## 7. TRAINING DNA ANALYSIS

### 7.1 Best Week Analysis
**Purpose:** Identify the most successful training week and analyze what made it work.

**Calculation:**
1. Look at last 3 months of workouts
2. Group by week (Monday to Sunday)
3. Find week with ≥2 workouts and highest average feeling score
4. Analyze the 4 weeks leading up to that week

### 7.2 Long-Term Trends (12-Week Analysis)
**Purpose:** Show how your training distribution is changing.

**Calculation:**
1. **Split last 12 weeks into two 6-week periods**
2. Count workouts of each type in each period
3. Calculate percentage change:
   ```
   Trend = ((Period1_Count - Period2_Count) / Period2_Count) × 100
   ```

### 7.3 Winning Formula
**Elements Extracted from Best Week's 4-Week Lead-up:**
- **TSS per Week:** Average TSS across the 4 weeks
- **Hours per Week:** Total volume across the 4 weeks
- **Sleep per Day:** Average sleep during period (if tracked)
- **HRV per Day:** Average HRV reading during period (if tracked)
- **Session Distribution:** Breakdown by workout type

**Function:** `calculateTrainingDNA(workouts, metrics, ftp)`

---

## 8. ADAPTATION & PERFORMANCE ANALYSIS

### 8.1 Adaptation Detection
**Purpose:** Identify training blocks where performance improved and classify them.

**Algorithm:**

1. **Group Workouts into Weekly Stats:**
   - TSS per week
   - Volume (hours) per week
   - Best power for 1m, 5m, 20m per week
   - Average feeling/strength rating

2. **Detect 4-Week Success Blocks:**
   - Compare current week to 4 weeks prior
   - Look for improvements in:
     - 20m power: +1.5% improvement (threshold)
     - 5m power: +1.5% improvement (VO2 Max)
     - 1m power: +1.5% improvement (Anaerobic)
   - Also check for volume growth >5% with feeling >4

3. **Classify Adaptation Type:**
   - **Recovery Adaptation:** TSS dropped 20%+ in this block vs previous block, while performance improved → Recovery effectiveness
   - **Stress Adaptation:** Performance improved at similar/higher stress → Good handling of training load

4. **Stagnation Detection:**
   - High TSS (>300/week) + Low average feeling (**<10 on scale)** + No improvement or decline
   - Flag as potential overtraining risk

**Function:** `analyzeAdaptations(workouts, metrics, ftpHistory)`
- Returns: `{ weeklyStats, adaptations[], stagnationZones[] }`

---

## 9. TRAINING RECOMMENDATIONS

### 9.1 Goal-Based Zone Distribution
**Modifiers by Training Goal:**

| Zone | Endurance | Climbing | Speed | Balanced |
|------|-----------|----------|-------|----------|
| Recovery | 10% | 10% | 10% | 12% |
| Endurance | 70% | 30% | 25% | 50% |
| Tempo | 12% | 25% | 15% | 18% |
| Threshold | 5% | 25% | 20% | 12% |
| VO2 Max | 3% | 10% | 20% | 8% |
| Anaerobic | - | - | 10% | - |

**Rationale:**
- **Endurance:** High Z2 volume for aerobic base
- **Climbing:** Balanced threshold + tempo for sustained power
- **Speed:** High intensity (VO2 + anaerobic) for repeatability

### 9.2 History-to-Goal Blending
**Weighting Strategy:**
- Historical patterns: 50% weight (what works for you)
- Goal modifiers: 40% weight (what you're targeting)
- Baseline distribution: 10% weight (neutral balance)

**Historical Pattern Detection:**
- If recent adaptations show volume gains → increase endurance percentage
- If recent adaptations show intensity gains → increase threshold/VO2 percentage

**Formula:**
```
Final_Zone_Weight = (History_Pct × 0.50) + (Goal_Pct × 0.40) + (Baseline_Pct × 0.10)
```

### 9.3 Session Plan Generation
**Algorithm:**

1. **Calculate Available Hours:** User input (hours per week available)

2. **Allocate by Zone:**
   - Recovery: `AvailableHours × Zone_Weight`
   - Endurance: `AvailableHours × Zone_Weight`
   - Tempo: `AvailableHours × Zone_Weight`
   - Threshold: `AvailableHours × Zone_Weight`
   - VO2 Max: `AvailableHours × Zone_Weight`
   - Anaerobic: `AvailableHours × Zone_Weight`

3. **Convert to Session Count:**
   - Recovery: 1x/week at 45-60 min
   - Endurance: 1-2x/week depending on time constraint
   - Tempo: 1x/week
   - Threshold: 1x/week
   - VO2 Max: 1x/week (if time allows)
   - Anaerobic: 1x/week (if speed goal and time allows)

4. **Time-Constraint Detection:**
   -** If available hours < 80% of historical success volume → use intensity progression
   - Otherwise → use volume progression**

**Function:** `generateSessionPlan(zoneDistribution, availabilityHours, avgSuccessVol)`

### 9.4 Four-Week Progressive Plan
**Progression Strategy:**

**Volume Progression (4-week cycle):**
- Week 1: Base (1.0x multiplier)
- Week 2: Build (+10% multiplier)
- Week 3: Peak (+15% multiplier)
- Week 4: Recovery (-20% multiplier)

**Intensity Progression (for time-constrained athletes):**
- Weeks 1-2: Maintain volume, standard intensity
- Week 3: +5% intensity focus
- Week 4: -15% intensity (recovery)

**Labels:**
- Week 1: "Base Building"
- Week 2: "Progressive Load"
- Week 3: "Peak Week"
- Week 4: "Recovery & Adaptation"

**Function:** `generateFourWeekPlan(baseWeeklyPlan, analysis, availabilityHours, avgSuccessVol, progressionType)`

### 9.5 Phenotype-Specific Strategy
**Sprinter targeting climbing:**
- Focus: Sustained Power Build
- Goal: Extend Time-to-Exhaustion (TTE) at threshold
- Increase threshold zone percentage

**Sprinter targeting speed:**
- Focus: Sharpening
- Goal: High-cadence sprints + anaerobic capacity
- Increase anaerobic percentage

**TT/Climber targeting climbing:**
- Focus: Natural Fit
- Goal: Weight management + long tempo climbs
- Keep threshold/tempo high, reduce recovery

**TT/Climber targeting speed:**
- Focus: Acceleration
- Goal: Build anaerobic capacity overtop steady base
- Add VO2 Max and anaerobic work

---

## 10. DATA FLOW & CALCULATIONS SUMMARY

### Workout Upload Flow:
1. User uploads FIT file
2. FIT parser extracts: power stream, HR stream, speed, duration, etc.
3. Auto-calculate power curve (best intervals at different durations)
4. Auto-calculate normalized power
5. Auto-calculate intensity factor
6. Auto-calculate TSS
7. Classify workout type
8. Store all metrics in database

### Weekly Analysis Flow:
1. Collect all workouts from past week
2. Calculate time in zones
3. Sum weekly TSS
4. Sum weekly volume
5. Calculate average intensity factor
6. Display in WeeklyStats component

### Performance Page Flow:
1. Get all workouts
2. Calculate aggregated power curve (best 6 weeks + all-time)
3. Calculate efficiency factor trends
4. Calculate critical power
5. Calculate critical heart rate
6. Estimate FTP
7. Calculate phenotype
8. Display Analysis page

### Recommendation Flow:
1. Analyze adaptations (12-week lookback)
2. Detect stagnation zones
3. Gather phenotype data
4. Get user goal and availability
5. Blend history + goal + availability
6. Generate session plan
7. Calculate 4-week progression
8. Return recommendation with narrative

---

## 11. KEY THRESHOLDS & CONSTANTS

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Drop tolerance | 30 seconds | Allow coasting in interval detection |
| HR drift threshold | 4% | Max allowed cardiac drift for eFTP |
| Min interval duration | 480s (8 min) | Minimum for session-derived FTP |
| Volume improvement threshold | 1.5% | Detect power gains |
| Overtraining TSS threshold | 300+ TSS | Flag high stress |
| Overtraining feeling threshold | **<10 (scale 1-10) |** Flag low feeling |
| Best week minimum workouts | 2 | Need 2+ rides to qualify |
| CP accuracy range | ±26 W | Expected variation (±19 to +33 W) |
| Performance decline threshold | -2% | Detect concerning drops |

---

## 12. CALCULATIONS USED IN UI COMPONENTS

### WeeklyStats Component:
- **Duration:** `SUM(total_elapsed_time) / 3600` (hours)
- **TSS:** `SUM(training_stress_score)`
- **Sleep:** `AVG(sleepHours)` per day in week
- **HRV:** `AVG(hrv)` per day in week

### Dashboard Component:
- Latest workout type (classification)
- Performance trend (power curve improvements)
- Next recommendation (generated from intelligence module)

### Analysis Page:
- Power curve chart (best powers at each duration)
- Time in zones pie/bar chart (aggregated from all workouts)
- Efficiency factor trend (over last 12 weeks)
- Critical power estimate
- FTP estimate
- Phenotype display

---

## 13. VALIDATION CHECKLIST

Use this to verify calculations:

- [ ] Zone boundaries calculated correctly at 55%, 75%, 90%, 105%, 120%, 150% of FTP
- [ ] TSS formula uses (Duration × NP × IF) / (FTP × 36)
- [ ] IF always equals NP / FTP
- [ ] NP calculated with 30s rolling average^4, then ^(1/4)
- [ ] Power curve tracks best powers for 8 durations
- [ ] CP calculated from (Work_20m - Work_3m) / (1200 - 180)
- [ ] eFTP requires > 1 hour duration AND TSS > 70
- [ ] Phenotype adjusts FTP estimates based on athlete type
- [ ] Workout classification uses interval detection, not just IF
- [ ] 4-week plan multipliers applied correctly (1.0, 1.10, 1.15, 0.80)
- [ ] Adaptation detection compares rolling 4-week windows
- [ ] Goal blending weights: 50% history, 40% goal, 10% baseline

---

## Questions for Verification

1. **FTP Estimation:** Does the suggested FTP update match your power curve improvements?
2. **Phenotype:** Does the classification (Sprinter/TT/All-Rounder) feel accurate?
3. **TSS:** Does a hard 1-hour ride show ~100 TSS, and an easy 2-hour ride show ~50-60 TSS?
4. **Zone Distribution:** Do the recommended zones align with your training success?
5. **4-Week Plan:** Does the progression feel sustainable (build, build, peak, recover)?
6. **Best Week Formula:** Does the suggested weekly volume match your successful patterns?

---

**Document Version:** 1.0  
**Last Updated:** February 2026  
**App Version:** Training Calendar V0.1


================================================================================

# SOURCE: FUTURE_TRAINING_BREAKDOWN.md
--------------------------------------------------------------------------------
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


================================================================================

# SOURCE: FUTURE_RECOMMENDATION_TEXT_BREAKDOWN.md
--------------------------------------------------------------------------------
# Future Recommendation Text Blocks: Complete Breakdown

## Sources
- Generator logic: src/utils/intelligence.js
- Strategy variants: src/utils/intelligence.js
- Description rendering: src/pages/FutureTraining.jsx

## How Description Is Built
The recommendation description is assembled as an array of text blocks (`advice`) and joined with blank lines:
- `description: advice.join('\n\n')`

The UI renders one paragraph per block by splitting on double newlines:
- `recommendation.description.split('\n\n')`

## All Possible Description Blocks

### 1) Insufficient-data fallback (single fixed description)
- Text:
  - Keep logging rides! We need more history to build a custom ML model for you.
- Trigger:
  - `!analysis || analysis.insufficientData`

### 2) Safety warning line 1
- Text pattern:
  - Safety Limit Applied: You requested Xh/week, but your recent average is Yh/week.
- Trigger:
  - `effectiveAvailability < availabilityHours`

### 3) Safety warning line 2
- Text pattern:
  - To prevent injury and overtraining, we've limited this plan to Zh/week (a safe 10% increase). Consistency beats intensity!
- Trigger:
  - Same condition as safety line 1.

### 4) Time-constrained context line
- Text pattern:
  - Your history shows success with Xh/week, but you have Yh available.
- Trigger:
  - `isTimeConstrained === true` and `isCapped === false`

### 5) Efficiency line
- Text:
  - This plan prioritizes intensity over volume-focus on high-quality sessions to maximize your training effect.
- Trigger:
  - `isTimeConstrained === true`

### 6) Proven-formula line 1
- Text pattern:
  - Your physiology responds well to volume-based training (best gains at Xh/week).
- Trigger:
  - `isTimeConstrained === false`
  - `successfulBlocks.length > 0`
  - `isCapped === false`

### 7) Proven-formula line 2
- Text pattern:
  - This plan maintains similar volume while tailoring zones to your goal.
- Trigger:
  - Same branch as proven-formula line 1.

### 8) Proven safe-build variant
- Text:
  - Your physiology responds well to volume, so we will build towards that safely.
- Trigger:
  - `isTimeConstrained === false`
  - `successfulBlocks.length > 0`
  - `isCapped === true`

### 9) Separator line
- Text:
  - ---
- Trigger:
  - `goal` is provided.

### 10) Goal strategy block (exactly one of these)

#### 10.1 Gap Closing
- Text starts with:
  - Gap Closing
- Trigger:
  - `phenotype` contains `sprinter`
  - `goal` contains `climbing`

#### 10.2 Sharpening the Sword
- Text starts with:
  - Sharpening the Sword
- Trigger:
  - `phenotype` contains `sprinter`
  - `goal` contains `speed`

#### 10.3 Natural Fit
- Text starts with:
  - Natural Fit
- Trigger:
  - `phenotype` contains `time trialist`
  - `goal` contains `climbing`

#### 10.4 Strategic Focus
- Text starts with:
  - Strategic Focus
- Trigger:
  - All other phenotype/goal combinations.

### 11) Risk warning
- Text pattern:
  - Risk Alert: You tend to stagnate above X TSS/week. Stay disciplined about recovery.
- Trigger:
  - `analysis.stagnationZones.length > 0`

## Ordering Rules (Important)
Blocks are appended in this order:
1. Safety lines (if capped)
2. Time-constrained branch OR proven-formula branch
3. Separator + strategy (if goal exists)
4. Risk alert (if stagnation exists)

## Title Options (for context)
- Data Building Phase
- Personalized Training Plan
- Efficiency-Focused Plan
- Proven Formula Refined

## Notes About Reachability
- The fallback text is returned early and does not include strategy/risk blocks.
- In the current UI flow, the Generate button is disabled until a goal is selected, so strategy text is typically present in non-fallback outputs.


================================================================================

