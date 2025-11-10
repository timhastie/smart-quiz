import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  console.log("[ProtectedRoute]", { ready, hasUser: !!user, path: location.pathname });
  if (!ready) {
    console.log("[ProtectedRoute] still waiting for ready");
    return null; // or a loader
  }
  if (!user) {
    console.log("[ProtectedRoute] no user -> redirecting to /login");
    return <Navigate to="/login" replace />;
  }
  return children;
}
