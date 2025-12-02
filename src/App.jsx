// src/App.jsx
import { Routes, Route, Navigate } from "react-router-dom";
import ProtectedRoute from "./auth/ProtectedRoute";
import Dashboard from "./pages/Dashboard";
import Editor from "./pages/Editor";
import Play from "./pages/Play";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import AuthCallback from "./pages/AuthCallback.jsx";
import SharedPlay from "./pages/SharedPlay";
import SharedQuizScores from "./pages/sharedQuizScores";
import SharedAttemptAnswers from "./pages/SharedAttemptAnswers";

export default function App() {
  return (
    <Routes>
      {/* QR Code Redirect Fallback */}
      <Route path="/qr" element={<Navigate to="/" replace />} />

      {/* Main dashboard (requires auth) */}
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

      {/* Individual quiz play (owner) */}
      <Route
        path="/play/:quizId"
        element={
          <ProtectedRoute>
            <Play />
          </ProtectedRoute>
        }
      />

      {/* Owner scoreboard for a given quiz (requires auth) */}
      <Route
        path="/scores/:quizId"
        element={
          <ProtectedRoute>
            <SharedQuizScores />
          </ProtectedRoute>
        }
      />

      {/* Detailed attempt view (owner) */}
      <Route
        path="/shared/:quizId/attempt/:attemptId"
        element={
          <ProtectedRoute>
            <SharedAttemptAnswers />
          </ProtectedRoute>
        }
      />

      {/* Public shared-quiz route (no auth required) */}
      <Route path="/share/:slug" element={<SharedPlay />} />

      {/* Quiz editor (requires auth) */}
      <Route
        path="/edit/:quizId"
        element={
          <ProtectedRoute>
            <Editor />
          </ProtectedRoute>
        }
      />

      {/* Auth routes */}
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
    </Routes>
  );
}
