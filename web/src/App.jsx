import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './components/Toast';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import NodesPage from './pages/NodesPage';
import RulesPage from './pages/RulesPage';
import UsersPage from './pages/UsersPage';
import TokensPage from './pages/TokensPage';
import AuditPage from './pages/AuditPage';
import BackupPage from './pages/BackupPage';
import SettingsPage from './pages/SettingsPage';
import AccountPage from './pages/AccountPage';
import SecurityPage from './pages/SecurityPage';

function ProtectedRoutes() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-500 border-t-transparent rounded-full" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/nodes" element={<NodesPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/tokens" element={<TokensPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/*" element={<ProtectedRoutes />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}