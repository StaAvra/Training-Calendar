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

The recommendation engine in [src/utils/intelligence.js](src/utils/intelligence.js) now uses a lightweight trained model from [src/utils/intelligence/mlModel.js](src/utils/intelligence/mlModel.js) to:

- build adaptation blocks from historical successful periods
- extract block features from volume, TSS, density, feeling, and zone mix
- classify the athlete as `Volume`, `Intensity`, `Balanced`, or `Mixed`
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

The first model version is `prototype-knn-v1` and works like this:

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

- [src/pages](src/pages): primary application screens
- [src/components](src/components): reusable UI components
- [src/utils/analysis.js](src/utils/analysis.js): physiological metrics, zones, and trend analysis
- [src/utils/intelligence.js](src/utils/intelligence.js): recommendation facade and planning logic
- [src/utils/intelligence/mlModel.js](src/utils/intelligence/mlModel.js): local ML responder model
- [src/utils/db.js](src/utils/db.js): IndexedDB access layer
- [backend/server.js](backend/server.js): Garmin and Strava integration backend

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
