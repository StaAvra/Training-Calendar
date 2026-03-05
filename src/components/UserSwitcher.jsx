import React, { useState } from 'react';
import { useUser } from '../context/UserContext';
import { User, ChevronDown, Plus, UserPlus } from 'lucide-react';
import styles from './UserSwitcher.module.css';

const UserSwitcher = () => {
    const { users, currentUser, switchUser, createNewUser } = useUser();
    const [isOpen, setIsOpen] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [newName, setNewName] = useState('');

    const handleSwitch = (id) => {
        switchUser(id);
        setIsOpen(false);
    };

    const handleCreate = (e) => {
        e.preventDefault();
        if (newName.trim()) {
            createNewUser(newName);
            setNewName('');
            setIsCreating(false);
            setIsOpen(false);
        }
    };

    if (!currentUser) return null;

    return (
        <div className={styles.container}>
            <button
                className={styles.trigger}
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className={styles.userInfo}>
                    <div className={styles.avatar}>
                        <User size={16} />
                    </div>
                    <span className={styles.username}>{currentUser.name}</span>
                </div>
                <ChevronDown size={14} />
            </button>

            {isOpen && (
                <div className={styles.dropdown}>
                    <div className={styles.userList}>
                        {users.map(u => (
                            <button
                                key={u.id}
                                className={`${styles.userItem} ${u.id === currentUser.id ? styles.active : ''}`}
                                onClick={() => handleSwitch(u.id)}
                            >
                                {u.name}
                            </button>
                        ))}
                    </div>

                    <div className={styles.divider}></div>

                    {isCreating ? (
                        <form onSubmit={handleCreate} className={styles.createForm}>
                            <input
                                autoFocus
                                placeholder="Name"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                className={styles.input}
                            />
                            <button type="submit" className={styles.addBtn}>Add</button>
                        </form>
                    ) : (
                        <button
                            className={styles.createBtn}
                            onClick={() => setIsCreating(true)}
                        >
                            <UserPlus size={14} />
                            <span>Add User</span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default UserSwitcher;
