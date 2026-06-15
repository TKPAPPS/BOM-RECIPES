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
import { ProfilePage } from './components/Profile/ProfilePage';
import { TabRoute } from './components/TabRoute';
import { LoginPage } from './pages/LoginPage';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { useAllowedTabs } from './hooks/useAllowedTabs';
import { firstAllowedPath } from './config/tabs';

/** Landing tab = the first tab the current role is permitted to see
 *  (per the manager-configurable role→tabs map). */
const HomeRedirect: React.FC = () => {
  const { allowed } = useAllowedTabs();
  return <Navigate to={firstAllowedPath(allowed) || '/book'} replace />;
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

        {/* Recipe Book */}
        <Route path="book"            element={<TabRoute tab="book"><RecipeBookList /></TabRoute>} />
        <Route path="book/:itemId"    element={<TabRoute tab="book"><RecipeBookDetail /></TabRoute>} />

        {/* Tab-gated routes — visibility per role is manager-configurable
            (Settings → Permissions); data ops stay protected server-side. */}
        <Route path="dashboard"       element={<TabRoute tab="dashboard"><DashboardPage /></TabRoute>} />
        <Route path="recipes"         element={<TabRoute tab="kitchen"><Navigate to="/kitchen" replace /></TabRoute>} />
        <Route path="recipes/base"    element={<TabRoute tab="kitchen"><BomHistory type="base"  /></TabRoute>} />
        <Route path="recipes/final"   element={<TabRoute tab="kitchen"><BomHistory type="final" /></TabRoute>} />
        <Route path="recipes/view/:itemId" element={<TabRoute tab="kitchen"><RecipeAdminView /></TabRoute>} />
        <Route path="kitchen"         element={<TabRoute tab="kitchen"><KitchenRecipes /></TabRoute>} />
        <Route path="recipes/print"   element={<TabRoute tab="kitchen"><RecipesPrintPage /></TabRoute>} />
        <Route path="recipe/new"      element={<TabRoute tab="kitchen"><RecipeBuilder /></TabRoute>} />
        <Route path="recipe/:itemId"  element={<TabRoute tab="kitchen"><RecipeBuilder /></TabRoute>} />
        <Route path="test-kitchen"      element={<TabRoute tab="test"><TestRecipes /></TabRoute>} />
        <Route path="test-recipe/new"   element={<TabRoute tab="test"><RecipeBuilder mode="test" /></TabRoute>} />
        <Route path="test-recipe/view/:itemId" element={<TabRoute tab="test"><TestRecipeView /></TabRoute>} />
        <Route path="test-recipe/:itemId" element={<TabRoute tab="test"><RecipeBuilder mode="test" /></TabRoute>} />
        <Route path="pending-recipes"   element={<TabRoute tab="pending"><PendingApproval /></TabRoute>} />
        <Route path="where-used"      element={<TabRoute tab="whereused"><WhereUsedPage /></TabRoute>} />
        <Route path="products"        element={<TabRoute tab="products"><ProductsPage /></TabRoute>} />
        <Route path="settings"        element={<TabRoute tab="settings"><SettingsPage /></TabRoute>} />
        <Route path="logs"            element={<TabRoute tab="logs"><LogsPage /></TabRoute>} />
        <Route path="profile"         element={<TabRoute tab="profile"><ProfilePage /></TabRoute>} />
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
