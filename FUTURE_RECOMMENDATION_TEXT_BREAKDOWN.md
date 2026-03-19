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
