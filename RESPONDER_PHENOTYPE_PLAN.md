# Responder Phenotype Detection & Intelligence Restructure

## Executive Summary

The current `intelligence.js` is minimalist and makes simplistic binary decisions (volume vs intensity based on time constraint). We need to:

1. **Detect responder phenotype** by analyzing how the user's adaptations correlate with training mix
2. **Track intensity-to-volume ratio** across successful blocks to identify patterns
3. **Classify users** as: Volume Responder, Intensity Responder, Balanced Responder, or Mixed/Complex
4. **Restructure intelligence.js** into modular, stateful analyzers for clarity and extensibility

### Confirmed Assumptions

- `time_in_zones` is available for all workouts, so responder detection can use direct zone attribution rather than inference.
- Responder type should be tracked over time, not treated as static. The system should detect when an athlete shifts from volume-responsive to intensity-responsive, or vice versa.
- Rider classification should be independent of the current goal. The goal should shape recommendation targeting, not phenotype detection.

---

## Part 1: Current Gaps

### What Currently Exists
- `analyzeAdaptations()` identifies "Stress Adaptation" and "Recovery Adaptation" blocks
- `blendHistoryWithGoal()` checks if recent adaptations have volume or intensity gains
- `determineProgressionStrategy()` returns "Volume" or "Intensity"
- **Issue**: Binary decision based on *count* of adaptations, not *intensity/volume ratio* of the mix

### What's Missing
- No **per-adaptation intensity-to-volume ratio** calculation
- No classification of user as "Volume", "Intensity", or "Balanced" responder
- No tracking of **zone distribution** during successful blocks (e.g., "This user improved VO2 Max during high-tempo blocks")
- No **predictive weight** assigned to each responder type (e.g., "60% volume responder, 40% intensity responder")
- No **historical mixing strategy** recommendation (e.g., "Your best gains came from 60% endurance, 20% tempo, 20% threshold")
- No **responder timeline** showing whether the athlete's optimal stimulus changed across seasons or training phases
- Current recommendation generation is **one-shot**; no learning loop

---

## Part 2: Proposed Architecture

### New Data Model: `ResponderProfile`

```javascript
{
  // Phenotype classification
  responderType: 'Volume' | 'Intensity' | 'Balanced' | 'Mixed',
  
  // Confidence scores (0-100)
  volumeResponderScore: 75,
  intensityResponderScore: 45,
  
  // Historical mix that worked best
  bestHistoricalMix: {
    recovery: 0.12,
    endurance: 0.65,
    tempo: 0.15,
    threshold: 0.06,
    vo2max: 0.02
  },
  
  // Adaptation patterns
  averageBlockStats: {
    tssPerWeek: 250,
    volumePerWeek: 8.5,
    improvementRate: 0.025, // % improvement per week
    recentFeelingTrend: 'improving' | 'stable' | 'declining'
  },
  
  // Key insights
  adaptationByZone: {
    // Which zones correlate with improvements?
    endurance: { improvementsCount: 5, avgTss: 120 },
    threshold: { improvementsCount: 2, avgTss: 180 },
    vo2max: { improvementsCount: 1, avgTss: 150 }
  },

  // Time-varying responder state
  responderTimeline: [
    {
      blockEnd: '2025-04-06',
      responderType: 'Volume',
      confidence: 68,
      dominantMix: { endurance: 0.62, tempo: 0.18, threshold: 0.12, vo2max: 0.08 }
    },
    {
      blockEnd: '2025-09-14',
      responderType: 'Intensity',
      confidence: 74,
      dominantMix: { endurance: 0.38, tempo: 0.20, threshold: 0.24, vo2max: 0.18 }
    }
  ],
  currentResponderType: 'Intensity',
  hasResponderShift: true,
  lastShiftDate: '2025-09-14',
  
  // Triggers for messaging
  intensityResponderFlag: false, // "You're an intensity-responder"
  volumeResponderFlag: false,    // "Your body loves volume"
  plateauFlag: false,             // "You may respond better to intensity now"
}
```

---

## Part 3: New Analysis Functions

### 1. `analyzeResponderProfile(analysis)`

**Purpose**: Classify user into responder phenotype based on historical data.

Responder classification is global and history-based. It should answer "what training mix does this athlete respond to?" rather than "what goal are they pursuing right now?"

**Logic**:
```javascript
export const analyzeResponderProfile = (analysis) => {
  if (!analysis.adaptations || analysis.adaptations.length < 3) {
    return { responderType: 'Undefined', confidence: 0 };
  }

  const profile = {
    volumeScore: 0,
    intensityScore: 0,
    adaptationMetrics: []
  };

  // Analyze each successful adaptation block
  analysis.adaptations.forEach(adaptation => {
    const blockMetrics = {
      date: adaptation.date,
      avgTss: adaptation.avgTss,
      avgVol: adaptation.avgVol,
      improvements: adaptation.improvements,
      feeling: adaptation.avgFeeling,
      
      // NEW: Calculate intensity-to-volume ratio
      intensityIndex: calculateIntensityIndex(adaptation.avgTss, adaptation.avgVol),
      
      // NEW: Detect which zones likely produced improvement
      improvedZones: detectImprovedZones(analysis, adaptation),
    };
    
    profile.adaptationMetrics.push(blockMetrics);
    
    // Score: If intensity was high relative to volume AND improvement happened
    if (blockMetrics.intensityIndex > 0.6 && adaptation.improvements.length > 0) {
      profile.intensityScore += adaptation.improvements.length * 2;
    }
    
    // Score: If volume was high and improvement happened
    if (adaptation.avgVol > 7 && adaptation.improvements.length > 0) {
      profile.volumeScore += adaptation.improvements.length;
    }
  });

  // Normalize scores
  const total = profile.volumeScore + profile.intensityScore || 1;
  profile.volumeResponderScore = Math.round((profile.volumeScore / total) * 100);
  profile.intensityResponderScore = Math.round((profile.intensityScore / total) * 100);

  // Classify
  let responderType = 'Balanced';
  if (profile.volumeResponderScore > 65) responderType = 'Volume';
  else if (profile.intensityResponderScore > 65) responderType = 'Intensity';
  else if (profile.volumeResponderScore > 55 && profile.intensityResponderScore > 45) responderType = 'Mixed';

  return {
    responderType,
    volumeResponderScore: profile.volumeResponderScore,
    intensityResponderScore: profile.intensityResponderScore,
    adaptationMetrics: profile.adaptationMetrics,
    bestHistoricalMix: calculateBestMix(profile.adaptationMetrics),
    recommendations: generateResponderRecommendations(responderType, profile)
  };
};
```

The goal should be applied after this step. In other words:

1. Classify the athlete from historical response patterns alone.
2. Identify the athlete's best historical mix.
3. Adapt that mix toward the selected goal without redefining the athlete's phenotype.

---

### 2. `calculateIntensityIndex(tss, volume)`

**Purpose**: Normalize TSS/Volume ratio into 0-1 scale representing intensity focus.

```javascript
export const calculateIntensityIndex = (avgTss, avgVol) => {
  if (!avgVol || avgVol === 0) return 0.5; // Neutral if no volume
  
  // Typical ratios:
  // Volume focus: 25-30 TSS/hour (low intensity)
  // Balanced: 30-35 TSS/hour
  // Intensity focus: 35-40+ TSS/hour (high intensity, short rides)
  
  const tssPerHour = avgTss / avgVol;
  
  // Normalize: 20 = 0.0 (very easy), 40 = 1.0 (very hard)
  const normalized = Math.min(1, Math.max(0, (tssPerHour - 20) / 20));
  
  return Math.round(normalized * 100) / 100;
};
```

---

### 3. `detectImprovedZones(analysis, adaptationBlock)`

**Purpose**: Aggregate the exact zone mix used during each adaptation block.

```javascript
export const detectImprovedZones = (analysis, adaptationBlock) => {
  // time_in_zones is assumed to exist for all workouts
  // Strategy: gather workouts in the adaptation window,
  // aggregate exact zone totals, and normalize them into a block mix
  
  const blockDate = adaptationBlock.date;
  const blockStart = subWeeks(blockDate, 4);
  
  const blockWorkouts = analysis.workouts.filter(w => {
    const workoutDate = new Date(w.date);
    return workoutDate >= blockStart && workoutDate <= blockDate;
  });
  
  // Aggregate zone distribution during this block
  const zoneAgg = {
    recovery: 0,
    endurance: 0,
    tempo: 0,
    threshold: 0,
    vo2max: 0
  };
  
  blockWorkouts.forEach(w => {
    if (w.time_in_zones) {
      Object.keys(zoneAgg).forEach(z => {
        zoneAgg[z] += w.time_in_zones[z] || 0;
      });
    }
  });

  const total = Object.values(zoneAgg).reduce((sum, value) => sum + value, 0) || 1;
  const normalizedMix = Object.fromEntries(
    Object.entries(zoneAgg).map(([zone, seconds]) => [zone, seconds / total])
  );
  
  return {
    zoneDistribution: normalizedMix,
    dominantZones: Object.entries(zoneAgg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([zone, time]) => ({ zone, time }))
  };
};
```

---

### 4. `detectResponderTransitions(adaptationMetrics)`

**Purpose**: Detect whether the athlete's responder type changes across rolling blocks or seasons.

```javascript
export const detectResponderTransitions = (adaptationMetrics) => {
  if (adaptationMetrics.length < 4) {
    return {
      responderTimeline: [],
      hasResponderShift: false,
      currentResponderType: 'Undefined'
    };
  }

  const windows = [];

  for (let i = 2; i < adaptationMetrics.length; i++) {
    const windowMetrics = adaptationMetrics.slice(Math.max(0, i - 2), i + 1);
    const avgIntensity = windowMetrics.reduce((sum, metric) => sum + metric.intensityIndex, 0) / windowMetrics.length;
    const avgEndurance = windowMetrics.reduce((sum, metric) => sum + (metric.zoneDistribution?.endurance || 0), 0) / windowMetrics.length;
    const avgHighIntensity = windowMetrics.reduce(
      (sum, metric) => sum + (metric.zoneDistribution?.threshold || 0) + (metric.zoneDistribution?.vo2max || 0),
      0
    ) / windowMetrics.length;

    let responderType = 'Balanced';
    if (avgHighIntensity > 0.32 || avgIntensity > 0.62) responderType = 'Intensity';
    else if (avgEndurance > 0.55 && avgIntensity < 0.48) responderType = 'Volume';

    windows.push({
      blockEnd: windowMetrics[windowMetrics.length - 1].date,
      responderType,
      confidence: Math.round(Math.abs(avgHighIntensity - avgEndurance) * 100),
      dominantMix: calculateBestMix(windowMetrics)
    });
  }

  const hasResponderShift = windows.some((window, index) => index > 0 && window.responderType !== windows[index - 1].responderType);

  return {
    responderTimeline: windows,
    hasResponderShift,
    lastShiftDate: hasResponderShift
      ? windows.find((window, index) => index > 0 && window.responderType !== windows[index - 1].responderType)?.blockEnd
      : null,
    currentResponderType: windows[windows.length - 1]?.responderType || 'Undefined'
  };
};
```

---

### 5. `calculateBestMix(adaptationMetrics)`

**Purpose**: Extract the zone distribution that produced best results.

```javascript
export const calculateBestMix = (adaptationMetrics) => {
  if (adaptationMetrics.length === 0) {
    return { recovery: 0.12, endurance: 0.60, tempo: 0.15, threshold: 0.10, vo2max: 0.03 };
  }

  // Rank adaptations by confidence (multiple improvements + high feeling)
  const ranked = adaptationMetrics
    .map(m => ({
      ...m,
      score: m.improvements.length * 2 + (m.feeling || 0)
    }))
    .sort((a, b) => b.score - a.score);

  // Take top 30% of adaptations
  const topAdaptations = ranked.slice(0, Math.max(1, Math.ceil(adaptationMetrics.length * 0.3)));

  // Average their zone distributions
  const mix = { recovery: 0, endurance: 0, tempo: 0, threshold: 0, vo2max: 0 };
  topAdaptations.forEach(a => {
    if (a.zoneDistribution) {
      Object.keys(mix).forEach(z => {
        mix[z] += a.zoneDistribution[z] || 0;
      });
    }
  });

  // Normalize
  const total = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  Object.keys(mix).forEach(z => {
    mix[z] = Math.round((mix[z] / total) * 1000) / 1000;
  });

  return mix;
};
```

---

### 6. `generateResponderRecommendations(responderType, profile)`

**Purpose**: Create personalized messaging that names the phenotype.

```javascript
export const generateResponderRecommendations = (responderType, profile) => {
  const intense = profile.intensityResponderScore;
  const volume = profile.volumeResponderScore;

  switch (responderType) {
    case 'Volume':
      return {
        title: "Volume Responder Identified",
        message: `You're a **volume-responder**—your physiology thrives on consistent, high-volume training. Your best results came after blocks averaging **${profile.adaptationMetrics[0]?.avgVol.toFixed(1)}h/week**.`,
        zoneRecommendation: "Prioritize endurance (60%+) with moderate intensity (tempo 15%, threshold 10%).",
        progressionTip: "Build volume gradually week-to-week; 10% increases are sustainable for you."
      };

    case 'Intensity':
      return {
        title: "Intensity Responder Identified",
        message: `You're an **intensity-responder**—your physiology responds rapidly to high-quality, focused intervals. Quality beats quantity for you.`,
        zoneRecommendation: "Shift to 50%+ in threshold/VO2 zones; reduce long endurance rides.",
        progressionTip: "Add intensity gradually; your body recovers fast but needs adequate rest between hard sessions."
      };

    case 'Balanced':
      return {
        title: "Balanced Responder",
        message: `You respond to a **balanced mix** of volume and intensity. Your adaptations are similar across different training approaches.`,
        zoneRecommendation: "Follow a polarized model: 70% easy, 30% hard—minimal tempo.",
        progressionTip: "Flexibility is your strength; vary approach month-to-month."
      };

    case 'Mixed':
      return {
        title: "Mixed Responder Profile",
        message: `Your profile shows both volume and intensity gains. You may be in a **transition phase** or have **goal-dependent responses**.`,
        zoneRecommendation: "Assess recent months: are volume gains old (burnout risk)? Are intensity gains recent (new capability)?",
        progressionTip: "Consider periodization: volume blocks during base phase, intensity during peak."
      };

    default:
      return {
        title: "Profile Pending",
        message: `Not enough data to classify your responder type yet. Keep training!`,
        zoneRecommendation: null,
        progressionTip: null
      };
  }
};
```

---

## Part 4: Integration into `generateRecommendation()`

Update the recommendation generation to use the new responder profile:

```javascript
export const generateRecommendation = (analysis, profile, goal, availabilityHours, daysAvailable = 5) => {
  // ... existing safety checks ...

  // NEW: Analyze responder phenotype
  const responderProfile = analyzeResponderProfile(analysis);
  const responderTransitions = detectResponderTransitions(responderProfile.adaptationMetrics);

  // Goal modifies prescription, not classification.
  // The athlete is classified first from history; the goal then bends the plan within safe bounds.
  const zoneDistribution = blendHistoryWithGoal(analysis, goal, avgSuccessVol, responderProfile);

  // ... generate session plan ...
  const weeklyPlan = generateSessionPlan(zoneDistribution, effectiveAvailability, avgSuccessVol, daysAvailable);

  // ... generate narrative ...
  let advice = [];

  // NEW MESSAGE: Responder phenotype insight
  if (responderProfile.responderType !== 'Undefined') {
    const respRec = responderProfile.recommendations;
    advice.push(`🎯 **${respRec.title}**`);
    advice.push(respRec.message);
    advice.push("");
    advice.push(`**Zone Recommendation**: ${respRec.zoneRecommendation}`);
    advice.push(`**Progression Tip**: ${respRec.progressionTip}`);

    if (responderTransitions.hasResponderShift) {
      advice.push(`**Responder Shift Detected**: Your training response changed around **${responderTransitions.lastShiftDate}**. The current plan should follow your more recent adaptation pattern rather than your older one.`);
    }
  }

  // ... rest of advice generation ...

  return {
    title,
    description: advice.join('\n\n'),
    focusZones: zoneDistributionToChart(zoneDistribution),
    weeklyPlan,
    fourWeekPlan,
    responderProfile: {
      ...responderProfile,
      ...responderTransitions
    } // NEW: Include for UI debugging
  };
};
```

---

## Part 5: Proposed Restructure of `intelligence.js`

### New File Structure

```
src/utils/
├── intelligence.js (high-level public API)
├── intelligence/
│   ├── adaptationAnalyzer.js       // analyzeAdaptations(), identify success blocks
│   ├── responderAnalyzer.js        // analyzeResponderProfile(), classification
│   ├── responderTimeline.js        // detectResponderTransitions(), responder shifts over time
│   ├── zoneOptimizer.js            // blendHistoryWithGoal(), zone distribution
│   ├── sessionPlanner.js           // generateSessionPlan(), session breakdown
│   ├── progressionBuilder.js       // generateFourWeekPlan(), periodization
│   ├── narrativeGenerator.js       // Craft advice strings, messaging
│   ├── metrics.js                  // Utility functions (calculateIntensityIndex, etc.)
│   └── constants.js                // Benchmarks, zone colors, default distributions
└── [existing analysis.js, garminApi.js, etc.]
```

### New `intelligence.js` (Facade)

```javascript
import { analyzeAdaptations } from './intelligence/adaptationAnalyzer.js';
import { analyzeResponderProfile, generateResponderRecommendations } from './intelligence/responderAnalyzer.js';
import { detectResponderTransitions } from './intelligence/responderTimeline.js';
import { blendHistoryWithGoal } from './intelligence/zoneOptimizer.js';
import { generateSessionPlan } from './intelligence/sessionPlanner.js';
import { generateFourWeekPlan } from './intelligence/progressionBuilder.js';
import { buildNarrative } from './intelligence/narrativeGenerator.js';

export const generateRecommendation = (analysis, profile, goal, availabilityHours, daysAvailable = 5) => {
  // 1. Analyze past adaptations
  // 2. Detect responder phenotype
  // 3. Blend history with goal
  // 4. Generate session plan
  // 5. Build 4-week progression
  // 6. Craft narrative with responder insights
  // ... returns unified recommendation object
};

export { analyzeAdaptations, analyzeResponderProfile, blendHistoryWithGoal };
```

### Benefits

1. **Modularity**: Each analyzer is independent, testable
2. **Clarity**: Function names are explicit (not buried in 700-line file)
3. **Extensibility**: Add `recoveryAnalyzer.js`, `injuryRiskAnalyzer.js` later without touching existing code
4. **Testability**: Mock individual analyzers for unit tests
5. **Debugging**: Each module can log independently

---

## Part 6: Expected User-Facing Changes

### Before (Current)

When opening a star report or generating a recommendation:
```
Title: "Efficiency-Focused Plan"
Description:
  ⚠️ Safety Limit Applied: You requested 10h/week...
  Your history shows success with 8.5h/week...
  This plan prioritizes intensity over volume...
  
  Gap Closing: As a Sprinter, sustained climbing is your limiter...
```

### After (Proposed)

```
Title: "Intensity Responder Identified"
Description:
  🎯 Intensity Responder Identified
  You're an intensity-responder—your physiology responds rapidly to 
  high-quality, focused intervals. Quality beats quantity for you.
  
  Zone Recommendation: Shift to 50%+ in threshold/VO2 zones; 
  reduce long endurance rides.
  
  Progression Tip: Add intensity gradually; your body recovers fast 
  but needs adequate rest between hard sessions.
  
  ---
  
  ⚠️ Safety Limit Applied: You requested 10h/week, but your recent 
  average is 8.5h/week. We've limited this plan to 9.35h/week...
  
  ---
  
  Gap Closing: As a Sprinter, sustained climbing is your limiter...
```

---

## Part 7: Implementation Roadmap

### Phase 1: Foundation (Week 1)
- [ ] Create `intelligence/` folder structure
- [ ] Move `analyzeAdaptations()` → `adaptationAnalyzer.js`
- [ ] Implement `calculateIntensityIndex()` in `metrics.js`
- [ ] Create `responderAnalyzer.js` with `analyzeResponderProfile()`
- [ ] Create `responderTimeline.js` with `detectResponderTransitions()`

### Phase 2: Integration (Week 2)
- [ ] Update `generateRecommendation()` to call `analyzeResponderProfile()`
- [ ] Merge responder timeline state into the returned recommendation payload
- [ ] Integrate responder messaging into `buildNarrative()`
- [ ] Refactor remaining functions into `zoneOptimizer.js`, `sessionPlanner.js`, etc.

### Phase 3: UI Display (Week 3)
- [ ] Update `StarWeekReportModal.jsx` to show responder phenotype badge
- [ ] Add responder profile card to Dashboard/Profile
- [ ] Display "Intensity Responder", "Volume Responder", etc. prominently

### Phase 4: Validation (Week 4)
- [ ] Manual testing: Verify responder classification on test athletes
- [ ] Unit tests for each analyzer
- [ ] Edge case handling (< 3 adaptations, mixed signals, etc.)

### Phase 5: ML Pipeline (Week 5+)
- [ ] Define training labels from historical adaptation outcomes
- [ ] Build feature extraction pipeline from block-level zone mix, volume, TSS, and progression context
- [ ] Create offline training dataset from historical workouts and adaptations
- [ ] Train first-pass responder classification model
- [ ] Train plan-effectiveness model to predict which mix is most likely to improve the athlete next
- [ ] Add model versioning, evaluation metrics, and fallback-to-rules behavior
- [ ] Integrate model inference into recommendation generation behind a feature flag

---

## Part 8: Data-Driven Insights to Track

Once implemented, we can answer:

1. **"What % of users are intensity vs volume responders?"** → Profile aggregation
2. **"Do responder types correlate with phenotype?"** (e.g., sprinters → intensity) → Statistical analysis
3. **"At what adaptation count is classification stable?"** → Confidence scoring
4. **"If user switches responder type, when did it happen and what changed in the block mix?"** → Trend detection + change-point analysis
5. **"Which zone mixes produce fastest improvements?"** → Zone effectiveness ranking
6. **"Can a trained model outperform the rule-based classifier on future adaptation prediction?"** → Offline model evaluation

---

## Part 10: ML Direction

The long-term direction should be a trained ML system, with the current statistical/rule-based logic retained as:

1. a bootstrap mechanism while data volume is still limited
2. a fallback when the model has low confidence
3. an interpretable baseline for debugging model behavior

### ML Objective

There are really two separate prediction tasks:

1. **Responder classification model**
  Input: athlete history up to now
  Output: probability of `Volume`, `Intensity`, `Balanced`, or `Mixed`

2. **Prescription model**
  Input: athlete history + current state + chosen goal + availability constraints
  Output: recommended future zone mix, weekly load target, and confidence score

The second model is the more valuable one. The first model is mostly a useful abstraction for UI and interpretability.

### Recommended Training Labels

For each historical 4-6 week block, derive labels such as:

- `adaptation_delta_cp20m`
- `adaptation_delta_cp5m`
- `adaptation_delta_cp1m`
- `adaptation_success_score`
- `responder_label` inferred from which type of block produced the strongest subsequent improvement

The first ML version should predict **expected improvement score from a proposed training mix** rather than only learning a hard responder label.

### Candidate Features

- Athlete baseline phenotype
- Recent 4-week, 8-week, and 12-week volume
- Recent 4-week, 8-week, and 12-week TSS
- Intensity index history
- Zone distribution history from `time_in_zones`
- Monotony / variability of load
- Number of high-intensity sessions per week
- Recovery density and rest spacing
- Subjective feeling trend
- Recent stagnation / overreaching signals
- Current goal and availability

### Modeling Approach

Start simple:

1. Gradient-boosted trees or random forest for tabular prediction
2. Compare against the current rule-based baseline
3. Add calibration so predicted probabilities are meaningful

Do not start with a deep learning model. The data size and interpretability needs do not justify it yet.

### Deployment Strategy

- Offline training first
- Save model artifact and version
- Run inference locally or on the backend
- Return:
  - predicted responder probabilities
  - recommended zone mix
  - confidence score
  - top feature contributions if supported

### Safety Constraint

Even with ML, keep hard guardrails outside the model:

- safe volume cap
- fatigue / stagnation warnings
- minimum data threshold
- fallback to rules when confidence is low

---

## Part 11: Example: User Joe (Intensity Responder)

### Historical Data
- 8 adaptations over 24 weeks
- Adaptation 1-3: Volume blocks (8h/week, 200-250 TSS) → CP20m +2%, slow
- Adaptation 4-8: Intensity blocks (5h/week, 280-320 TSS) → CP5m +5%, CP1m +8%, fast

### Analysis
```
volumeScore = 3 (adaptations 1-3) + 5 (improvements) = moderate
intensityScore = 5 (adaptations 4-8) * 2 (high TSS/vol ratio) + 8 (improvements) = high
=> responderType = 'Intensity'
=> intensityResponderScore = 72%
```

### Recommendation
```
🎯 Intensity Responder Identified
You're an intensity-responder—your recent blocks show that 
focused, short hard sessions drive your gains much faster than 
high-volume endurance. Your last 4 intensity blocks averaged 
305 TSS/week at 5.2h duration, with improvements in VO2 Max 
and Anaerobic power.

Zone Recommendation: Shift to 55% in threshold/VO2 zones with 
only 1 long endurance ride per week. Reduce steady-state tempo.

Progression Tip: Your body recovers fast but needs 2-3 full rest 
days between hard sessions to avoid burnout. Quality > Quantity.
```

---

## Part 12: Success Criteria

1. ✅ Users are classified into responder type (Volume, Intensity, Balanced, or Mixed)
2. ✅ Classification confidence score reflects data sufficiency
3. ✅ Recommendation narr includes explicit responder phenotype messaging (e.g., "You're an intensity-responder")
4. ✅ Recommendation uses historical best mix (not just goal + time constraint)
5. ✅ UI displays responder badge/classification prominently
6. ✅ Code is modular, testable, and maintainable
7. ✅ Edge cases handled (< 3 adaptations, conflicting signals, etc.)

---

## Confirmed Product Decisions

1. `time_in_zones` is available for all workouts and should be used directly in block analysis.
2. The system should detect responder shifts over time rather than assigning one permanent label.
3. Rider classification is independent of goal selection; goals modify the plan after phenotype detection.
4. Responder phenotype UI should stay where it currently appears rather than being moved to a new surface.
5. The long-term direction is to train an ML model, while keeping rule-based logic as the initial baseline and fallback.

## Open Questions

No open product questions currently captured in this plan.
