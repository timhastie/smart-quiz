// src/auth/ProtectedRoute.jsx
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  console.log("[ProtectedRoute]", {
    path: location.pathname,
    ready,
    hasUser: !!user,
  });

  if (!ready) {
    console.log("[ProtectedRoute] still waiting for ready");
    return null; // or a spinner
  }

  if (!user) {
    console.log("[ProtectedRoute] no user -> /login");
    return <Navigate to="/login" replace />;
  }

  return children;
}
