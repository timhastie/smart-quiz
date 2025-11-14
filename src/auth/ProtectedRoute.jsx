// src/auth/ProtectedRoute.jsx
import { useAuth } from './AuthProvider';
import SigningInOverlay from '../components/SigningInOverlay';

export default function ProtectedRoute({ children }) {
  const { user, ready, oauthRedirecting } = useAuth();

  if (!ready || !user || oauthRedirecting) {
    return <SigningInOverlay />;
  }

  return children;
}
