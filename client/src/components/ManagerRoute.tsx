import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Client-side gate for manager-only routes (e.g. the Pending Approval
 * queue).  Belt-and-suspenders — the server also enforces requireManager.
 * Non-managers are bounced to the recipe book.
 */
export const ManagerRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'manager') return <Navigate to="/book" replace />;
  return <>{children}</>;
};
