// src/auth/ProtectedRoute.jsx
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center text-white/80">
        <div className="text-sm">Loading…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
}