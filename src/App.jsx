import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Calendar from './pages/Calendar';
import Analysis from './pages/Analysis';
import Profile from './pages/Profile';
import { UserProvider } from './context/UserContext';
import FutureTraining from './pages/FutureTraining';
import Simulation from './pages/Simulation';
import StravaCallback from './pages/StravaCallback';

function App() {
  return (
    <UserProvider>
      <Router>
        <Routes>
          {/* Standalone Strava OAuth callback - no Layout wrapper */}
          <Route path="strava-callback" element={<StravaCallback />} />
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="analysis" element={<Analysis />} />
            <Route path="future" element={<FutureTraining />} />
            <Route path="profile" element={<Profile />} />
            <Route path="simulation" element={<Simulation />} />
          </Route>
        </Routes>
      </Router>
    </UserProvider>
  );
}

export default App;
