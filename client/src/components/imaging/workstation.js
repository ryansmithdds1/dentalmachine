// Which imaging workstation this computer is (remembered per browser: the PC in Op 2 is always Op 2).
const WS_KEY = 'dm_workstation';
export const readWs = () => {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
};
export const saveWs = (id) => {
  try {
    localStorage.setItem(WS_KEY, id);
  } catch {
    /* per-browser convenience only */
  }
};
