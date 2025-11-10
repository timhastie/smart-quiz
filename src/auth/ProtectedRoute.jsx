import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  console.log("[ProtectedRoute]", { ready, hasUser: !!user });
  if (!ready) return null; // or a loader
  if (!user) return <Navigate to="/login" replace />;
  return children;
}
