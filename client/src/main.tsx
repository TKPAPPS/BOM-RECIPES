import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Route,
  Navigate,
  RouterProvider,
} from 'react-router-dom';
import './styles/main.css';
import { App, BomHistory, SettingsPage } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RecipeBuilder } from './components/RecipeBuilder/RecipeBuilder';
import { WhereUsedPage } from './components/WhereUsedPage/WhereUsedPage';
import { RecipeBookList } from './components/RecipeBook/RecipeBookList';
import { RecipeBookDetail } from './components/RecipeBook/RecipeBookDetail';
import { RecipeAdminView } from './components/RecipeBook/RecipeAdminView';
import { DashboardPage } from './components/Dashboard/DashboardPage';
import { LogsPage } from './components/Logs/LogsPage';
import { ProductsPage } from './components/Products/ProductsPage';
import { LoginPage } from './pages/LoginPage';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AdminRoute } from './components/AdminRoute';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';

const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      {/* ── Public: login ─────────────────────────────────── */}
      <Route
        path="/login"
        element={
          <LanguageProvider>
            <LoginPage />
          </LanguageProvider>
        }
      />

      {/* ── Protected: everything else ────────────────────── */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <App />
          </ProtectedRoute>
        }
      >
        {/* Default landing — admins land on the Dashboard, customers
            are redirected by AdminRoute to /book. */}
        <Route index element={<Navigate to="/dashboard" replace />} />

        {/* Customer + admin routes (Recipe Book) */}
        <Route path="book"            element={<RecipeBookList />} />
        <Route path="book/:itemId"    element={<RecipeBookDetail />} />

        {/* Admin-only routes */}
        <Route path="dashboard"       element={<AdminRoute><DashboardPage /></AdminRoute>} />
        <Route path="recipes"         element={<AdminRoute><Navigate to="/recipes/base" replace /></AdminRoute>} />
        <Route path="recipes/base"    element={<AdminRoute><BomHistory type="base"  /></AdminRoute>} />
        <Route path="recipes/final"   element={<AdminRoute><BomHistory type="final" /></AdminRoute>} />
        <Route path="recipes/view/:itemId" element={<AdminRoute><RecipeAdminView /></AdminRoute>} />
        <Route path="recipe/new"      element={<AdminRoute><RecipeBuilder /></AdminRoute>} />
        <Route path="recipe/:itemId"  element={<AdminRoute><RecipeBuilder /></AdminRoute>} />
        <Route path="where-used"      element={<AdminRoute><WhereUsedPage /></AdminRoute>} />
        <Route path="products"        element={<AdminRoute><ProductsPage /></AdminRoute>} />
        <Route path="settings"        element={<AdminRoute><SettingsPage /></AdminRoute>} />
        <Route path="logs"            element={<AdminRoute><LogsPage /></AdminRoute>} />
      </Route>
    </>
  )
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
