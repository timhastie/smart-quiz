// src/App.jsx
import { Routes, Route } from "react-router-dom";
import ProtectedRoute from "./auth/ProtectedRoute";
import Dashboard from "./pages/Dashboard";
import Editor from "./pages/Editor";
import Play from "./pages/Play";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import AuthCallback from "./pages/AuthCallback.jsx";

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />

      {/* Put this BEFORE /play/:quizId so "all" isn't captured as a quizId */}
      <Route
        path="/play/all"
        element={
          <ProtectedRoute>
            <Play />
          </ProtectedRoute>
        }
      />

      {/* Group review (single group) */}
      <Route
        path="/play/group/:groupId"
        element={
          <ProtectedRoute>
            <Play />
          </ProtectedRoute>
        }
      />

      {/* Individual quiz */}
      <Route
        path="/play/:quizId"
        element={
          <ProtectedRoute>
            <Play />
          </ProtectedRoute>
        }
      />

      <Route path="/edit/:quizId" element={<ProtectedRoute><Editor /></ProtectedRoute>} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
    </Routes>
  );
}
