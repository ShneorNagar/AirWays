import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LANGS, type Lang, type Strings } from "./strings";

const STORAGE_KEY = "lang";
const DEFAULT_LANG: Lang = "he";

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "he" || v === "en" ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LangContext = createContext<LangState>({ lang: DEFAULT_LANG, setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);

  useEffect(() => {
    const { strings, dir } = LANGS[lang];
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    document.title = `${strings.appName} — ${strings.appTagline}`;
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
  };

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

export const useLang = () => useContext(LangContext);
export const useT = (): Strings => LANGS[useLang().lang].strings;

export function LanguageToggle() {
  const { lang, setLang } = useLang();
  const S = useT();
  const next: Lang = lang === "he" ? "en" : "he";
  return (
    <button
      className="lang-btn"
      onClick={() => setLang(next)}
      lang={next}
      title={S.switchTo}
      aria-label={`${S.langName} → ${S.switchTo}`}
    >
      🌐 {S.switchTo}
    </button>
  );
}
