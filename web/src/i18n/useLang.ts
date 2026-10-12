import { useEffect, useState } from 'react'
import { getLang, type Lang, onLangChange, setLang } from './engine'

/** 지금 화면 언어와 바꾸는 함수 (언어 선택 UI 용) */
export function useLang(): [Lang, (lang: Lang) => void] {
  const [lang, setState] = useState<Lang>(getLang)
  useEffect(() => onLangChange(setState), [])
  return [lang, setLang]
}
