import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Client-side gate for admin-only routes.  Belt-and-suspenders only —
 * the server enforces the same policy on every endpoint (STEP 2).
 * Customers landing on an admin URL are redirected to the Recipe
 * Book rather than seeing a 403 page.
 */
export const AdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/book" replace />;
  return <>{children}</>;
};
