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
import { KitchenRecipes } from './components/KitchenRecipes/KitchenRecipes';
import { RecipesPrintPage } from './components/KitchenRecipes/RecipesPrintPage';
import { TestRecipes } from './components/TestRecipes/TestRecipes';
import { PendingApproval } from './components/TestRecipes/PendingApproval';
import { TestRecipeView } from './components/TestRecipes/TestRecipeView';
import { ManagerRoute } from './components/ManagerRoute';
import { LoginPage } from './pages/LoginPage';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AdminRoute } from './components/AdminRoute';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';

/** Role-aware landing: manager → Dashboard, admin → Kitchen Recipes,
 *  customer (and anyone else) → Recipe Book. */
const HomeRedirect: React.FC = () => {
  const { user } = useAuth();
  const to = user?.role === 'manager' ? '/dashboard'
    : user?.role === 'admin' ? '/test-kitchen'
    : '/book';
  return <Navigate to={to} replace />;
};

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
        {/* Default landing is role-aware: manager → Dashboard,
            admin → Kitchen Recipes, customer → Recipe Book. */}
        <Route index element={<HomeRedirect />} />

        {/* Customer + admin routes (Recipe Book) */}
        <Route path="book"            element={<RecipeBookList />} />
        <Route path="book/:itemId"    element={<RecipeBookDetail />} />

        {/* Admin-only routes */}
        <Route path="dashboard"       element={<ManagerRoute><DashboardPage /></ManagerRoute>} />
        {/* Real recipe management is manager-only (admins use Test Recipes). */}
        <Route path="recipes"         element={<ManagerRoute><Navigate to="/kitchen" replace /></ManagerRoute>} />
        <Route path="recipes/base"    element={<ManagerRoute><BomHistory type="base"  /></ManagerRoute>} />
        <Route path="recipes/final"   element={<ManagerRoute><BomHistory type="final" /></ManagerRoute>} />
        <Route path="recipes/view/:itemId" element={<ManagerRoute><RecipeAdminView /></ManagerRoute>} />
        <Route path="kitchen"         element={<ManagerRoute><KitchenRecipes /></ManagerRoute>} />
        <Route path="recipes/print"   element={<ManagerRoute><RecipesPrintPage /></ManagerRoute>} />
        <Route path="recipe/new"      element={<ManagerRoute><RecipeBuilder /></ManagerRoute>} />
        <Route path="recipe/:itemId"  element={<ManagerRoute><RecipeBuilder /></ManagerRoute>} />
        <Route path="test-kitchen"      element={<AdminRoute><TestRecipes /></AdminRoute>} />
        <Route path="test-recipe/new"   element={<AdminRoute><RecipeBuilder mode="test" /></AdminRoute>} />
        <Route path="test-recipe/view/:itemId" element={<AdminRoute><TestRecipeView /></AdminRoute>} />
        <Route path="test-recipe/:itemId" element={<AdminRoute><RecipeBuilder mode="test" /></AdminRoute>} />
        <Route path="pending-recipes"   element={<ManagerRoute><PendingApproval /></ManagerRoute>} />
        <Route path="where-used"      element={<ManagerRoute><WhereUsedPage /></ManagerRoute>} />
        <Route path="products"        element={<AdminRoute><ProductsPage /></AdminRoute>} />
        <Route path="settings"        element={<ManagerRoute><SettingsPage /></ManagerRoute>} />
        <Route path="logs"            element={<ManagerRoute><LogsPage /></ManagerRoute>} />
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
