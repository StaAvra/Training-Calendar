import React, { useState } from 'react';
import { analyzeAdaptations, generateRecommendation } from '../utils/intelligence';
import { addWeeks, subWeeks, startOfDay } from 'date-fns';
import { ArrowRight, RefreshCw, AlertTriangle, CheckCircle, Activity } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

const Simulation = () => {
    const [scenario, setScenario] = useState('volume_responder');
    const [simData, setSimData] = useState(null);
    const [analysisResult, setAnalysisResult] = useState(null);

    // Mock Data Generators
    const generateMockData = (type) => {
        const workouts = [];
        let currentDate = subWeeks(new Date(), 24); // 6 months history
        let currentCp = 250;
        let currentTss = 300;
        let feeling = 8;

        for (let i = 0; i < 24; i++) {
            // Weekly Pattern
            if (type === 'volume_responder') {
                // Scenario: Increasing Volume -> Increasing CP
                // Every 4 weeks, bump volume/TSS and see CP gain
                if (i % 4 === 0 && i > 0) {
                    currentTss += 50;
                    currentCp += 5; // Good adaptation
                }
                feeling = 8;
            } else if (type === 'overtraining') {
                // Scenario: High TSS -> CP Stagnation/Drop + Low Feeling
                if (i > 12) {
                    currentTss = 600; // Spike
                    feeling = 3; // Terrible feeling
                    if (i > 16) currentCp -= 5; // Performance decay
                } else {
                    currentTss += 20;
                    currentCp += 1;
                    feeling = 7;
                }
            } else if (type === 'taper_success') {
                // Scenario: High Load -> Fatigue -> Taper -> Supercompensation
                if (i < 16) {
                    currentTss = 500;
                    feeling = 5;
                    currentCp = 260; // Stagnant
                } else if (i >= 16 && i < 20) {
                    // Taper
                    currentTss = 200;
                    feeling = 9;
                } else {
                    // Race block / Realization
                    currentTss = 250;
                    currentCp = 280; // BOOM
                    feeling = 9;
                }
            }

            // Generate 4 workouts per week to simulate density
            for (let j = 0; j < 4; j++) {
                const wDate = new Date(currentDate);
                wDate.setDate(wDate.getDate() + j);

                workouts.push({
                    date: wDate.toISOString(),
                    total_elapsed_time: (currentTss / 4) * 3600 / 50, // rough approx
                    training_stress_score: currentTss / 4,
                    feeling_strength: feeling,
                    power_curve: {
                        duration_60: currentCp * 1.5,
                        duration_300: currentCp * 1.2,
                        duration_1200: currentCp
                    }
                });
            }
            currentDate = addWeeks(currentDate, 1);
        }
        return workouts;
    };

    const runSimulation = () => {
        const workouts = generateMockData(scenario);
        const metrics = []; // Not used heavily yet
        const analysis = analyzeAdaptations(workouts, metrics, []);

        let profile = { phenotype: 'All Rounder' };
        if (scenario === 'volume_responder') profile.phenotype = 'Time Trialist';

        const rec = generateRecommendation(analysis, profile, 'Climbing', 10);

        setSimData(workouts);
        setAnalysisResult({ analysis, rec });
    };

    // Prepare chart data
    const chartData = analysisResult?.analysis?.weeklyStats.map(w => ({
        date: w.date.toLocaleDateString(),
        tss: w.tss,
        cp20m: w.performance.cp20m,
        feeling: w.feeling
    }));

    return (
        <div className="container" style={{ padding: '2rem' }}>
            <h1 className="text-2xl font-bold mb-4">ML Intelligence Simulator</h1>
            <p className="text-muted mb-8">Generate artificial history to verify the Intelligence Engine's logic.</p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

                {/* Controls */}
                <div style={{ background: 'var(--bg-secondary)', padding: '1.5rem', borderRadius: '12px' }}>
                    <h3 className="font-bold mb-4">1. Select Scenario</h3>

                    <div className="flex flex-col gap-2 mb-6">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="scenario"
                                value="volume_responder"
                                checked={scenario === 'volume_responder'}
                                onChange={e => setScenario(e.target.value)}
                            />
                            <div>
                                <span className="font-bold block">Volume Responder</span>
                                <span className="text-xs text-muted">Steady progression: TSS ↑ results in CP ↑</span>
                            </div>
                        </label>

                        <label className="flex items-center gap-2 cursor-pointer mt-2">
                            <input
                                type="radio"
                                name="scenario"
                                value="overtraining"
                                checked={scenario === 'overtraining'}
                                onChange={e => setScenario(e.target.value)}
                            />
                            <div>
                                <span className="font-bold block text-red-400">Overtraining Trap</span>
                                <span className="text-xs text-muted">High TSS spike + Low Feeling = Stagnation</span>
                            </div>
                        </label>

                        <label className="flex items-center gap-2 cursor-pointer mt-2">
                            <input
                                type="radio"
                                name="scenario"
                                value="taper_success"
                                checked={scenario === 'taper_success'}
                                onChange={e => setScenario(e.target.value)}
                            />
                            <div>
                                <span className="font-bold block text-green-400">Taper Supercomp</span>
                                <span className="text-xs text-muted">TSS ↓ leads to Performance Breakthrough</span>
                            </div>
                        </label>
                    </div>

                    <button
                        onClick={runSimulation}
                        className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold flex items-center justify-center gap-2"
                    >
                        <RefreshCw size={18} /> Run Simulation
                    </button>
                </div>

                {/* Results */}
                <div>
                    {analysisResult ? (
                        <>
                            <div className="mb-8 p-6 border border-gray-700 rounded-xl bg-gray-900">
                                <h2 className="text-xl font-bold text-blue-400 mb-2">{analysisResult.rec.title}</h2>
                                <div className="text-gray-300 whitespace-pre-line">
                                    {analysisResult.rec.description}
                                </div>
                            </div>

                            <div className="h-64 mb-6">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={chartData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                        <XAxis dataKey="date" stroke="#666" fontSize={12} />
                                        <YAxis yAxisId="left" stroke="#3b82f6" label={{ value: 'CP (W)', angle: -90, position: 'insideLeft' }} />
                                        <YAxis yAxisId="right" orientation="right" stroke="#888" label={{ value: 'TSS', angle: 90, position: 'insideRight' }} />
                                        <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }} />
                                        <Legend />
                                        <Line yAxisId="left" type="monotone" dataKey="cp20m" stroke="#3b82f6" strokeWidth={3} name="Threshold (20m)" dot={false} />
                                        <Line yAxisId="right" type="monotone" dataKey="tss" stroke="#9ca3af" strokeWidth={2} name="Weekly TSS" strokeDasharray="5 5" dot={false} />
                                        <Line yAxisId="right" type="monotone" dataKey="feeling" stroke="#10b981" strokeWidth={1} name="Feeling (1-10)" dot={false} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="p-4 bg-gray-800 rounded-lg">
                                    <h4 className="font-bold text-gray-400 text-sm mb-2">DETECTED ADAPTATIONS</h4>
                                    {analysisResult.analysis.adaptations.length === 0 && <p className="text-sm text-gray-500">None detected</p>}
                                    {analysisResult.analysis.adaptations.map((a, i) => (
                                        <div key={i} className="mb-2 text-sm">
                                            <span className={a.type === 'Recovery Adaptation' ? 'text-green-400' : 'text-blue-400'}>
                                                {new Date(a.date).toLocaleDateString()}: {a.type}
                                            </span>
                                            <div className="text-xs text-gray-500">{a.improvements.join(', ')}</div>
                                        </div>
                                    ))}
                                </div>

                                <div className="p-4 bg-gray-800 rounded-lg">
                                    <h4 className="font-bold text-gray-400 text-sm mb-2">STAGNATION ZONES</h4>
                                    {analysisResult.analysis.stagnationZones.length === 0 && <p className="text-sm text-green-500 flex items-center gap-2"><CheckCircle size={14} /> No overtraining detected</p>}
                                    {analysisResult.analysis.stagnationZones.map((z, i) => (
                                        <div key={i} className="mb-2 text-sm text-red-400">
                                            <div className="flex items-center gap-1"><AlertTriangle size={14} /> {new Date(z.date).toLocaleDateString()}</div>
                                            <div className="text-xs text-gray-500">{z.reason} (Feeling: {z.feeling.toFixed(1)})</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-gray-500 border border-dashed border-gray-700 rounded-xl">
                            <Activity size={48} className="mb-4 opacity-50" />
                            <p>Select a scenario and run simulation to see results</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Simulation;
