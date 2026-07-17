import { useState } from "react";

const KEY = "ucpa-favs";

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

// Favorites are browser-local only, keyed the same way a week's React `key`
// already is (`${code}-${start_date}`) -- no server round-trip, no cross-
// device sync, just a small persisted array that survives a page reload.
export default function useFavorites() {
  const [favorites, setFavorites] = useState(load);

  function toggle(key) {
    setFavorites((favs) => {
      const next = favs.includes(key) ? favs.filter((f) => f !== key) : [...favs, key];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // private browsing / storage disabled -- favorites just won't persist
      }
      return next;
    });
  }

  return [favorites, toggle];
}
