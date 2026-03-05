import React, { createContext, useState, useEffect, useContext } from 'react';
import { db } from '../utils/db';

const UserContext = createContext();

export const UserProvider = ({ children }) => {
    const [users, setUsers] = useState([]);
    const [currentUser, setCurrentUser] = useState(null);
    const [loading, setLoading] = useState(true);

    const loadUsers = async () => {
        const allUsers = await db.getUsers();
        setUsers(allUsers);

        // Auto-select first user or restore from local storage (if we persisted ID)
        const storedId = localStorage.getItem('currentUserId');
        if (storedId) {
            const found = allUsers.find(u => u.id === Number(storedId));
            if (found) {
                setCurrentUser(found);
                setLoading(false);
                return;
            }
        }

        if (allUsers.length > 0) {
            setCurrentUser(allUsers[0]);
        } else {
            // Create default user if none exist
            const id = await db.addUser('User 1');
            const newUser = await db.getUsers(); // Refresh to get full object
            setUsers(newUser);
            setCurrentUser(newUser[0]);
        }
        setLoading(false);
    };

    useEffect(() => {
        loadUsers();
    }, []);

    const switchUser = (userId) => {
        const user = users.find(u => u.id === Number(userId));
        if (user) {
            setCurrentUser(user);
            localStorage.setItem('currentUserId', user.id);
        }
    };

    const createNewUser = async (name) => {
        await db.addUser(name);
        await loadUsers(); // Refresh list
        // Optionally switch to new user immediately?
    };

    const updateProfile = async (newProfileData) => {
        if (!currentUser) return;
        const updatedUser = { ...currentUser, profile: newProfileData };
        await db.updateUser(currentUser.id, { profile: newProfileData });
        setCurrentUser(updatedUser);
        // Update in users list too locally
        setUsers(users.map(u => u.id === currentUser.id ? updatedUser : u));
    };

    return (
        <UserContext.Provider value={{ users, currentUser, switchUser, createNewUser, updateProfile, loading }}>
            {children}
        </UserContext.Provider>
    );
};

export const useUser = () => useContext(UserContext);
