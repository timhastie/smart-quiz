// src/auth/ProtectedRoute.jsx
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    console.log("[ProtectedRoute] waiting for auth", location.pathname);
    return null; // or a spinner
  }

  if (!user) {
    console.warn("[ProtectedRoute] no user, redirecting to /login from", location.pathname);
    return <Navigate to="/login" replace />;
  }

  console.log("[ProtectedRoute] access granted for", location.pathname, "user", user.id);
  return children;
}
