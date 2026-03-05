import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Calendar, Activity, User, Target } from 'lucide-react';
import styles from './Layout.module.css';

import UserSwitcher from './UserSwitcher';

const Layout = () => {
  return (
    <div className={styles.appContainer}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <Activity size={32} color="var(--text-accent)" />
          <span>VeloTrain</span>
        </div>

        <UserSwitcher />

        <nav className={styles.nav}>
          <NavLink
            to="/"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <LayoutDashboard size={20} />
            <span>Dashboard</span>
          </NavLink>

          <NavLink
            to="/calendar"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <Calendar size={20} />
            <span>Calendar</span>
          </NavLink>

          <NavLink
            to="/analysis"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <Activity size={20} />
            <span>Analysis</span>
          </NavLink>

          <NavLink
            to="/future"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <Target size={20} />
            <span>Future Plans</span>
          </NavLink>

          <NavLink
            to="/profile"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <User size={20} />
            <span>Profile</span>
          </NavLink>
        </nav>
      </aside>

      <main className={styles.mainContent}>
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
