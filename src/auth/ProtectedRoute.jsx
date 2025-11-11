// src/auth/ProtectedRoute.jsx
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return null; // or a spinner
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
