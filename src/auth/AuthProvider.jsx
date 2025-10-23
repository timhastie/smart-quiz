import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signup = (email, password) => supabase.auth.signUp({ email, password });
  const signin = (email, password) => supabase.auth.signInWithPassword({ email, password });
  const signout = () => supabase.auth.signOut();

  return (
    <AuthCtx.Provider value={{ user, ready, signup, signin, signout }}>
      {children}
    </AuthCtx.Provider>
  );
}
