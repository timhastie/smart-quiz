import { Routes, Route } from 'react-router-dom';
import ProtectedRoute from './auth/ProtectedRoute';
import Dashboard from './pages/Dashboard';
import Editor from './pages/Editor';
import Play from './pages/Play';
import Login from './pages/Login';
import Signup from './pages/Signup';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/edit/:quizId" element={<ProtectedRoute><Editor /></ProtectedRoute>} />
      <Route path="/play/:quizId" element={<ProtectedRoute><Play /></ProtectedRoute>} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
    </Routes>
  );
}
