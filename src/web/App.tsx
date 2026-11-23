import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api, type Me } from "./api";
import Layout from "./components/Layout";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import Home from "./pages/Home";
import Leaderboard from "./pages/Leaderboard";
import MatchReplay from "./pages/MatchReplay";
import Submit from "./pages/Submit";
import { useT } from "./i18n";

interface MeState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const MeContext = createContext<MeState>({ me: null, loading: true, refresh: async () => {} });
export const useMe = () => useContext(MeContext);

export default function App() {
  const S = useT();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <MeContext.Provider value={{ me, loading, refresh }}>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/submit" element={<Submit />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/match/:id" element={<MatchReplay />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<p className="card">{S.errors.notFound}</p>} />
        </Routes>
      </Layout>
    </MeContext.Provider>
  );
}
