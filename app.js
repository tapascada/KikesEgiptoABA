/**
 * KIKES ABA - PROGRESSIVE WEB APP (PWA)
 * SCADA Productividad, OEE Gauge y Reporte Consolidado
 * Integración con Google Drive API v3 y ClosedXML/SheetJS
 */

// =============================================================================
// 1. CONFIGURACIÓN Y CONSTANTES (Client-Side Seguro sin Secret)
// =============================================================================
const CONFIG = {
  CLIENT_ID: '830764017290-lhj433d1luv0okqfefs1maba7omrjjjj.apps.googleusercontent.com',
  DEFAULT_FOLDER_ID: '1qE9yA8y9f5lBJ5p91VjqAIcmlTa7WqAi',
  SCOPES: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
  STORAGE_KEYS: {
    AUTH_TOKEN: 'kikes_aba_auth_token',
    AUTH_EXPIRY: 'kikes_aba_auth_expiry',
    USER_INFO: 'kikes_aba_user_info',
    CACHED_BACHES: 'kikes_aba_cached_baches',
    LAST_SYNC: 'kikes_aba_last_sync'
  },
  PAGE_SIZE_PROD: 15,
  PAGE_SIZE_BACHES: 15
};

// =============================================================================
// 2. ESTADO GLOBAL DE LA APLICACIÓN
// =============================================================================
const AppState = {
  accessToken: localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN) || null,
  tokenExpiry: parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_EXPIRY) || '0', 10),
  userInfo: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.USER_INFO) || 'null'),
  folderId: CONFIG.DEFAULT_FOLDER_ID,
  
  allBaches: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.CACHED_BACHES) || '[]'),
  filteredBaches: [],
  
  // Filtros
  currentPeriod: 'all',
  selectedTurno: 0, // 0: Todos, 1, 2, 3
  customDateFrom: null,
  customDateTo: null,
  selectedFormula: '',
  searchTerm: '',
  
  // Productividad
  movingAverageWindow: 10,
  sortByTask: false,
  pageProd: 1,
  
  // Consolidado
  groupingModeCons: 0, // 0: Día, 1: Semana, 2: Mes, 3: Turno, 4: Día y Turno
  metricCons: 0, // 0: Baches, 1: Toneladas, 2: Baches/h, 3: Ton/h
  
  // Baches Explorer
  pageBaches: 1,
  
  // Charts & Gauge
  charts: {
    prod: null,
    cons: null
  },
  gaugeValue: 0,
  gaugeTarget: 0,
  gaugeAnimationId: null,
  
  isSyncing: false
};

// =============================================================================
// 3. INICIALIZACIÓN
// =============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initServiceWorker();
  initEventListeners();
  setupInitialDates();
  initGaugeCanvas();

  // 1. Revisar si regresamos con un código de autorización OAuth en la URL (?code=...)
  const hasAuthCode = await checkUrlAuthCode();
  
  if (!hasAuthCode) {
    // 2. Revisar si hay token válido en localStorage
    if (AppState.accessToken && Date.now() < AppState.tokenExpiry) {
      updateUserUI();
      hideLoginModal();
      if (AppState.allBaches.length > 0) {
        applyFiltersAndRender();
      }
      syncDataFromGoogleDrive();
    } else {
      showLoginModal();
    }
  }
});

function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('PWA Service Worker activo:', reg.scope))
      .catch(err => console.warn('Error al registrar Service Worker:', err));
  }
}

function setupInitialDates() {
  const today = new Date().toISOString().split('T')[0];
  const dateFrom = document.getElementById('date-from');
  const dateTo = document.getElementById('date-to');
  if (dateFrom) dateFrom.value = today;
  if (dateTo) dateTo.value = today;
}

// =============================================================================
// 4. AUTENTICACIÓN SEGURA GOOGLE IDENTITY SERVICES (GIS / TOKEN FLOW - SIN SECRET)
// =============================================================================
let gisTokenClient = null;

function initGisAuthClient() {
  if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
    try {
      gisTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: async (tokenRes) => {
          if (tokenRes.error) {
            console.error('GIS Error:', tokenRes);
            showToast('Error en autenticación: ' + tokenRes.error, 'error');
            return;
          }
          if (tokenRes.access_token) {
            AppState.accessToken = tokenRes.access_token;
            AppState.tokenExpiry = Date.now() + (parseInt(tokenRes.expires_in || 3600, 10) * 1000) - 60000;
            localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN, AppState.accessToken);
            localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_EXPIRY, AppState.tokenExpiry.toString());
            await fetchUserInfoAndSync();
          }
        }
      });
    } catch (err) {
      console.warn('No se pudo inicializar GIS Token Client:', err);
    }
  }
}

async function loginWithGoogle() {
  // Intentar abrir el popup moderno de Google Identity Services
  if (!gisTokenClient) {
    initGisAuthClient();
  }

  if (gisTokenClient) {
    gisTokenClient.requestAccessToken({ prompt: 'select_account' });
  } else {
    // Redirección directa con Token Flow (sin secret)
    const redirectUri = window.location.origin + window.location.pathname;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(CONFIG.CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent(CONFIG.SCOPES)}` +
      `&prompt=select_account`;

    window.location.href = authUrl;
  }
}

async function checkUrlAuthCode() {
  // 1. Revisar si hay un access_token en el Hash (#access_token=...&expires_in=...)
  const hash = window.location.hash.substring(1);
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    const token = hashParams.get('access_token');
    const expiresIn = parseInt(hashParams.get('expires_in') || '3600', 10);

    if (token) {
      AppState.accessToken = token;
      AppState.tokenExpiry = Date.now() + (expiresIn * 1000) - 60000;
      localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN, AppState.accessToken);
      localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_EXPIRY, AppState.tokenExpiry.toString());

      window.history.replaceState(null, null, window.location.pathname);
      await fetchUserInfoAndSync();
      return true;
    }
  }

  return false;
}

async function fetchUserInfoAndSync() {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${AppState.accessToken}` }
    });
    if (res.ok) {
      const info = await res.json();
      AppState.userInfo = info;
      localStorage.setItem(CONFIG.STORAGE_KEYS.USER_INFO, JSON.stringify(info));
    }
  } catch (err) {
    console.warn('No se pudo obtener info de usuario:', err);
  }

  updateUserUI();
  hideLoginModal();
  showToast('Autenticado con éxito', 'success');
  syncDataFromGoogleDrive();
}

function logoutGoogle() {
  AppState.accessToken = null;
  AppState.tokenExpiry = 0;
  AppState.userInfo = null;
  localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
  localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_EXPIRY);
  localStorage.removeItem(CONFIG.STORAGE_KEYS.USER_INFO);

  updateUserUI();
  showLoginModal();
  showToast('Sesión cerrada correctamente.', 'info');
}

function showLoginModal() {
  const modal = document.getElementById('login-overlay');
  if (modal) modal.classList.remove('hidden');
}

function hideLoginModal() {
  const modal = document.getElementById('login-overlay');
  if (modal) modal.classList.add('hidden');
}

function updateUserUI() {
  const emailDisplay = document.getElementById('user-email-display');
  const avatarInitials = document.getElementById('user-avatar-initials');
  const settingsEmail = document.getElementById('settings-user-email');

  const email = AppState.userInfo?.email || 'Usuario KIKES';
  const name = AppState.userInfo?.name || email;
  const initial = name.charAt(0).toUpperCase();

  if (emailDisplay) emailDisplay.textContent = email;
  if (avatarInitials) avatarInitials.textContent = initial;
  if (settingsEmail) settingsEmail.textContent = email;
}

// =============================================================================
// 5. LECTURA Y DESCARGA DIRECTA DESDE GOOGLE DRIVE API
// =============================================================================
async function syncDataFromGoogleDrive() {
  if (!AppState.accessToken || Date.now() >= AppState.tokenExpiry) {
    loginWithGoogle();
    return;
  }

  if (AppState.isSyncing) return;
  AppState.isSyncing = true;

  updateSyncStatus('syncing', 'Sincronizando...');
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    const folderId = CONFIG.DEFAULT_FOLDER_ID;
    showToast('Consultando carpetas en Google Drive...', 'info');

    // 1. Escanear recursivamente la carpeta raíz y todas las subcarpetas mensuales
    const allFiles = await fetchAllExcelFilesRecursive(folderId, AppState.accessToken);

    if (allFiles.length === 0) {
      updateSyncStatus('ready', 'Sin archivos');
      showToast('No se encontraron archivos de baches en Google Drive.', 'info');
      AppState.isSyncing = false;
      if (refreshBtn) refreshBtn.classList.remove('spinning');
      return;
    }

    showToast(`Descargando ${allFiles.length} archivo(s) diarios desde Google Drive...`, 'info');

    // 3. Descargar y parsear cada archivo Excel
    const collectedBaches = [];
    for (const file of allFiles) {
      try {
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
        const fileRes = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${AppState.accessToken}` }
        });

        if (fileRes.ok) {
          const buffer = await fileRes.arrayBuffer();
          const parsed = parseExcelWorkbook(buffer, file.name);
          collectedBaches.push(...parsed);
        }
      } catch (errFile) {
        console.warn(`Error al leer archivo ${file.name}:`, errFile);
      }
    }

    // 4. Consolidar baches únicos
    const uniqueMap = new Map();
    for (const b of collectedBaches) {
      const key = `${b.OP}_${b.Numero_Bache}_${b.Fecha_Fin || b.Fecha_Inicio}`;
      uniqueMap.set(key, b);
    }

    AppState.allBaches = Array.from(uniqueMap.values());

    // Ordenar cronológicamente (Fecha_Fin ASC para cálculos de productividad acumulada)
    AppState.allBaches.sort((a, b) => new Date(a.Fecha_Fin || a.Fecha_Inicio || 0) - new Date(b.Fecha_Fin || b.Fecha_Inicio || 0));

    localStorage.setItem(CONFIG.STORAGE_KEYS.CACHED_BACHES, JSON.stringify(AppState.allBaches));
    localStorage.setItem(CONFIG.STORAGE_KEYS.LAST_SYNC, new Date().toISOString());

    updateSyncStatus('ready', 'Al día');
    showToast(`Sincronización completada: ${AppState.allBaches.length} baches listos.`, 'success');

    populateFormulaFilter();
    applyFiltersAndRender();

  } catch (ex) {
    console.error('Error durante la sincronización de Google Drive:', ex);
    updateSyncStatus('error', 'Error Drive');
    showToast(`Error al sincronizar: ${ex.message || ex}`, 'error');
  } finally {
    AppState.isSyncing = false;
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

// Explorador recursivo para traer todos los archivos .xlsx de la carpeta raíz y todas las subcarpetas mensuales
async function fetchAllExcelFilesRecursive(rootFolderId, accessToken) {
  const queue = [rootFolderId];
  const visited = new Set();
  const excelFiles = [];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const url = `https://www.googleapis.com/drive/v3/files?q='${encodeURIComponent(currentId)}'+in+parents+and+trashed=false&pageSize=1000&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.ok) {
        const data = await res.json();
        const items = data.files || [];
        for (const item of items) {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            queue.push(item.id);
          } else if (
            item.name.toLowerCase().endsWith('.xlsx') ||
            item.name.toLowerCase().endsWith('.xls') ||
            item.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          ) {
            excelFiles.push(item);
          }
        }
      }
    } catch (err) {
      console.warn(`Error escaneando carpeta ${currentId}:`, err);
    }
  }

  return excelFiles;
}

// Parser de Fechas Flexible (Soporta DD/MM/YYYY, ISO YYYY-MM-DD, y objetos Date)
function parseDateFlexible(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val;
  }
  if (typeof val === 'number') {
    // Fecha serial de Excel
    return new Date(Math.round((val - 25569) * 86400 * 1000));
  }
  const str = String(val).trim();
  if (!str) return null;

  // DD/MM/YYYY o DD-MM-YYYY HH:mm:ss
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const hour = parseInt(dmyMatch[4] || 0, 10);
    const min = parseInt(dmyMatch[5] || 0, 10);
    const sec = parseInt(dmyMatch[6] || 0, 10);
    return new Date(year, month, day, hour, min, sec);
  }

  // YYYY-MM-DD o YYYY/MM/DD HH:mm:ss
  const isoMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const hour = parseInt(isoMatch[4] || 0, 10);
    const min = parseInt(isoMatch[5] || 0, 10);
    const sec = parseInt(isoMatch[6] || 0, 10);
    return new Date(year, month, day, hour, min, sec);
  }

  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateToIso(d) {
  if (!d || isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// Parser SheetJS
function parseExcelWorkbook(buffer, fileName) {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  return jsonRows.map(row => {
    const op = row['OP'] || row['Op'] || '';
    const tarea = row['Tarea'] || '';
    const numeroBache = parseInt(row['Bache #'] || row['Numero_Bache'] || row['Bache'] || 0, 10);
    const codFormula = row['Cód. Fórmula'] || row['Codigo_Formula'] || '';
    const nombreFormula = row['Fórmula'] || row['Nombre_Formula'] || 'Fórmula';
    const version = parseInt(row['Versión'] || row['Version'] || 1, 10);
    const pesoMeta = parseFloat(row['Peso Meta (kg)'] || row['PesoMeta'] || 0);
    const pesoReal = parseFloat(row['Peso Real (kg)'] || row['PesoReal'] || 0);
    const desviacion = parseFloat(row['Desviación (kg)'] || row['Desviacion_Peso'] || (pesoReal - pesoMeta));
    const estado = row['Estado'] || 'Finalizado';
    
    const rawInicio = row['Fecha Inicio'] || row['Fecha_Inicio'] || '';
    const rawFin = row['Fecha Fin'] || row['Fecha_Fin'] || '';
    const duracion = row['Duración'] || row['Duracion'] || '';

    const dInicio = parseDateFlexible(rawInicio);
    const dFin = parseDateFlexible(rawFin);

    const fechaInicio = dInicio ? formatDateToIso(dInicio) : String(rawInicio);
    const fechaFin = dFin ? formatDateToIso(dFin) : String(rawFin);

    return {
      OP: op,
      Tarea: tarea,
      Numero_Bache: numeroBache,
      Codigo_Formula: codFormula,
      Nombre_Formula: nombreFormula,
      Version: version,
      PesoMeta: isNaN(pesoMeta) ? 0 : pesoMeta,
      PesoReal: isNaN(pesoReal) ? 0 : pesoReal,
      Desviacion_Peso: isNaN(desviacion) ? 0 : desviacion,
      Estado: estado,
      Fecha_Inicio: fechaInicio,
      Fecha_Fin: fechaFin,
      Duracion: duracion,
      FileName: fileName
    };
  });
}

function updateSyncStatus(state, text) {
  const pill = document.getElementById('sync-status-pill');
  const statusText = document.getElementById('sync-status-text');
  if (!pill || !statusText) return;

  pill.className = 'status-pill ' + state;
  statusText.textContent = text;
}

// =============================================================================
// 6. MOTOR DE TURNOS Y FILTROS
// =============================================================================
/**
 * Determina el turno correspondiente y la fecha operativa para una fecha dada (idéntico al SCADA de escritorio)
 */
function obtenerInfoTurno(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) {
    return { turnoNombre: 'Turno 1 (06 - 14)', turnoNumero: 1, fechaOperativa: new Date() };
  }

  const hours = dateObj.getHours();
  const minutes = dateObj.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  // Turno 1: 06:00 a 14:00 (360 a 840 min)
  if (totalMinutes >= 360 && totalMinutes < 840) {
    return { turnoNombre: 'Turno 1 (06 - 14)', turnoNumero: 1, fechaOperativa: new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()) };
  }
  // Turno 2: 14:00 a 22:00 (840 a 1320 min)
  else if (totalMinutes >= 840 && totalMinutes < 1320) {
    return { turnoNombre: 'Turno 2 (14 - 22)', turnoNumero: 2, fechaOperativa: new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()) };
  }
  // Turno 3: 22:00 a 06:00
  else {
    if (totalMinutes < 360) {
      // Antes de las 06:00 AM pertenece al turno 3 del día anterior
      const prevDay = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
      prevDay.setDate(prevDay.getDate() - 1);
      return { turnoNombre: 'Turno 3 (22 - 06)', turnoNumero: 3, fechaOperativa: prevDay };
    } else {
      return { turnoNombre: 'Turno 3 (22 - 06)', turnoNumero: 3, fechaOperativa: new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()) };
    }
  }
}

function parseDurationToSeconds(str, fechaInicioStr, fechaFinStr) {
  if (str) {
    const s = String(str).trim();

    // Caso A: Formatos con texto como "4 min 37 s", "4m 37s", "16 min 33 s", "4 min", "37 s", "1h 15m 20s"
    const hourMatch = s.match(/(\d+)\s*(?:h|hr|hrs|hora|horas)/i);
    const minMatch = s.match(/(\d+)\s*(?:m|min|mins|minuto|minutos)/i);
    const secMatch = s.match(/(\d+)\s*(?:s|seg|segs|segundo|segundos)/i);

    if (hourMatch || minMatch || secMatch) {
      const h = hourMatch ? parseInt(hourMatch[1], 10) : 0;
      const m = minMatch ? parseInt(minMatch[1], 10) : 0;
      const sec = secMatch ? parseInt(secMatch[1], 10) : 0;
      const total = h * 3600 + m * 60 + sec;
      if (total > 0) return total;
    }

    // Caso B: Formato estándar con dos puntos "HH:mm:ss" o "mm:ss"
    if (s.includes(':')) {
      const parts = s.split(':').map(p => parseFloat(p.trim()));
      if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return parts[0] * 60 + parts[1];
      }
    }

    // Caso C: Segundos puros como número
    const num = parseFloat(s);
    if (!isNaN(num) && num > 0) return num;
  }

  // Fallback: Calcular la diferencia real en segundos entre Fecha_Fin y Fecha_Inicio
  const d1 = parseDateFlexible(fechaInicioStr);
  const d2 = parseDateFlexible(fechaFinStr);
  if (d1 && d2) {
    const diff = (d2.getTime() - d1.getTime()) / 1000;
    if (diff > 5 && diff < 86400) return diff;
  }

  return 240; // fallback 4 minutos
}

function applyFiltersAndRender() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  let filtered = [...AppState.allBaches];

  // 1. Filtro de Período
  if (AppState.currentPeriod === '1h') {
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
    filtered = filtered.filter(b => {
      const d = new Date((b.Fecha_Fin || b.Fecha_Inicio || '').replace(' ', 'T'));
      return d >= oneHourAgo;
    });
  } else if (AppState.currentPeriod === '8h') {
    const eightHoursAgo = new Date(now.getTime() - 8 * 3600 * 1000);
    filtered = filtered.filter(b => {
      const d = new Date((b.Fecha_Fin || b.Fecha_Inicio || '').replace(' ', 'T'));
      return d >= eightHoursAgo;
    });
  } else if (AppState.currentPeriod === 'turno_actual') {
    const currentTurno = obtenerInfoTurno(now);
    const opDateStr = currentTurno.fechaOperativa.toISOString().split('T')[0];
    filtered = filtered.filter(b => {
      const d = new Date((b.Fecha_Fin || b.Fecha_Inicio || '').replace(' ', 'T'));
      const t = obtenerInfoTurno(d);
      const bOpDateStr = t.fechaOperativa.toISOString().split('T')[0];
      return t.turnoNumero === currentTurno.turnoNumero && bOpDateStr === opDateStr;
    });
  } else if (AppState.currentPeriod === 'today') {
    filtered = filtered.filter(b => (b.Fecha_Fin || b.Fecha_Inicio || '').startsWith(todayStr));
  } else if (AppState.currentPeriod === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yestStr = yesterday.toISOString().split('T')[0];
    filtered = filtered.filter(b => (b.Fecha_Fin || b.Fecha_Inicio || '').startsWith(yestStr));
  } else if (AppState.currentPeriod === 'week') {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStr = weekAgo.toISOString().split('T')[0];
    filtered = filtered.filter(b => (b.Fecha_Fin || b.Fecha_Inicio || '').split(' ')[0] >= weekStr);
  } else if (AppState.currentPeriod === 'month') {
    const currentMonth = now.toISOString().substring(0, 7);
    filtered = filtered.filter(b => (b.Fecha_Fin || b.Fecha_Inicio || '').startsWith(currentMonth));
  } else if (AppState.currentPeriod === 'custom') {
    const from = AppState.customDateFrom || '1970-01-01';
    const to = AppState.customDateTo || '2099-12-31';
    filtered = filtered.filter(b => {
      const fDate = (b.Fecha_Fin || b.Fecha_Inicio || '').split(' ')[0];
      return fDate >= from && fDate <= to;
    });
  }

  // 2. Filtro de Turno específico
  if (AppState.selectedTurno > 0) {
    filtered = filtered.filter(b => {
      const d = new Date((b.Fecha_Fin || b.Fecha_Inicio || '').replace(' ', 'T'));
      const t = obtenerInfoTurno(d);
      return t.turnoNumero === parseInt(AppState.selectedTurno, 10);
    });
  }

  // 3. Filtro por Fórmula
  if (AppState.selectedFormula) {
    filtered = filtered.filter(b => b.Nombre_Formula === AppState.selectedFormula || b.Codigo_Formula === AppState.selectedFormula);
  }

  // 4. Búsqueda de Texto
  if (AppState.searchTerm) {
    const term = AppState.searchTerm.toLowerCase();
    filtered = filtered.filter(b => 
      b.OP.toLowerCase().includes(term) ||
      b.Tarea.toLowerCase().includes(term) ||
      b.Nombre_Formula.toLowerCase().includes(term) ||
      b.Codigo_Formula.toLowerCase().includes(term) ||
      b.Estado.toLowerCase().includes(term)
    );
  }

  AppState.filteredBaches = filtered;
  AppState.pageProd = 1;
  AppState.pageBaches = 1;

  // Procesar cálculos de Productividad y Consolidado
  processProductivityAndRender(filtered);
  processConsolidatedAndRender(filtered);
  renderBachesTable(filtered);
}

function formatSecondsCompact(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return `${m} min ${s} s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h} h ${remM} min`;
}

// =============================================================================
// 7. CÁLCULO Y RENDERIZADO DE PRODUCTIVIDAD (TAB 1 & BANNER)
// =============================================================================
function processProductivityAndRender(baches) {
  const windowSize = AppState.movingAverageWindow;
  const bphBuffer = [];
  const tphBuffer = [];

  let minBph = 999.0;
  let maxBph = 0.0;
  let minSec = 999999;
  let maxSec = 0;

  const enrichedRows = [];
  const chartPoints = [];

  // 1. Ordenar cronológicamente por Fecha_Fin ASC
  const chronological = [...baches].sort((a, b) => {
    const da = parseDateFlexible(a.Fecha_Fin || a.Fecha_Inicio) || new Date(0);
    const db = parseDateFlexible(b.Fecha_Fin || b.Fecha_Inicio) || new Date(0);
    return da - db;
  });

  for (let i = 0; i < chronological.length; i++) {
    const b = chronological[i];
    const dFin = parseDateFlexible(b.Fecha_Fin);
    const dInicio = parseDateFlexible(b.Fecha_Inicio);

    let durSec = 0;

    // Calcular diferencia entre la Fecha_Fin de este bache contra la Fecha_Fin del bache anterior (LAG)
    if (i > 0 && dFin) {
      const prevBache = chronological[i - 1];
      const dPrevFin = parseDateFlexible(prevBache.Fecha_Fin);
      if (dPrevFin) {
        const diff = (dFin.getTime() - dPrevFin.getTime()) / 1000;
        // Si el tiempo es válido (entre 5 seg y 12 horas)
        if (diff > 5 && diff < 43200) {
          durSec = diff;
        }
      }
    }

    // Si es el primer bache de la serie o no hubo bache previo cercano, usar su duración individual
    if (durSec <= 0) {
      durSec = parseDurationToSeconds(b.Duracion, b.Fecha_Inicio, b.Fecha_Fin);
    }

    const pesoRealKg = b.PesoReal || 0.0;
    const pesoRealTon = pesoRealKg / 1000.0;

    let bph = 0.0;
    let tph = 0.0;

    if (durSec > 10.0) {
      bph = Math.round((3600.0 / durSec) * 100) / 100;
      tph = Math.round((pesoRealTon * bph) * 100) / 100;

      if (bph < minBph) minBph = bph;
      if (bph > maxBph) maxBph = bph;
      if (durSec < minSec) minSec = durSec;
      if (durSec > maxSec) maxSec = durSec;
    }

    if (bph > 0) {
      bphBuffer.push(bph);
      if (bphBuffer.length > windowSize) bphBuffer.shift();

      tphBuffer.push(tph);
      if (tphBuffer.length > windowSize) tphBuffer.shift();
    }

    const bphMovil = bphBuffer.length > 0 ? Math.round((bphBuffer.reduce((a, v) => a + v, 0) / bphBuffer.length) * 100) / 100 : 0.0;
    const tphMovil = tphBuffer.length > 0 ? Math.round((tphBuffer.reduce((a, v) => a + v, 0) / tphBuffer.length) * 100) / 100 : 0.0;

    const formattedDur = formatSecondsCompact(durSec);

    const enriched = {
      ...b,
      DuracionSegundos: durSec,
      DuracionFormateada: formattedDur,
      Baches_Hora: bph,
      Baches_Hora_Movil: bphMovil,
      Ton_Hora: tph,
      Ton_Hora_Movil: tphMovil
    };

    enrichedRows.push(enriched);
    chartPoints.push(enriched);
  }

  // Si no hubo valores válidos, resetear mínimos
  if (minBph === 999.0) minBph = 0.0;
  if (minSec === 999999) minSec = 0;

  // Promedios globales
  const totalBaches = baches.length;
  const totalKg = baches.reduce((acc, b) => acc + (b.PesoReal || 0), 0);
  const totalTon = totalKg / 1000.0;

  const validBphList = enrichedRows.map(r => r.Baches_Hora).filter(v => v > 0);
  const avgBph = validBphList.length > 0 ? (validBphList.reduce((a, v) => a + v, 0) / validBphList.length) : 0.0;
  const avgTph = avgBph * (totalBaches > 0 ? (totalTon / totalBaches) : 0);

  // 1. Actualizar Banner Superior
  document.getElementById('txt-total-baches').textContent = totalBaches.toLocaleString('es-CO');
  document.getElementById('txt-sub-toneladas').textContent = `${totalTon.toFixed(2)} Ton producidas`;
  
  // Rango fechas
  if (baches.length > 0) {
    const fFirst = (baches[0].Fecha_Fin || baches[0].Fecha_Inicio || '').split(' ')[0];
    const fLast = (baches[baches.length - 1].Fecha_Fin || baches[baches.length - 1].Fecha_Inicio || '').split(' ')[0];
    document.getElementById('txt-fechas-rango').textContent = fFirst === fLast ? fFirst : `${fFirst} al ${fLast}`;
  } else {
    document.getElementById('txt-fechas-rango').textContent = 'Sin datos';
  }

  // Turno activo label
  const turnoTxt = AppState.selectedTurno === 1 ? 'Turno 1 (06 - 14)' :
                   AppState.selectedTurno === 2 ? 'Turno 2 (14 - 22)' :
                   AppState.selectedTurno === 3 ? 'Turno 3 (22 - 06)' : 'Todos los Turnos';
  document.getElementById('txt-turno-activo-label').textContent = turnoTxt;

  document.getElementById('txt-min-bph').textContent = `${minBph.toFixed(2)} /h`;
  document.getElementById('txt-max-bph').textContent = `${maxBph.toFixed(2)} /h`;
  document.getElementById('txt-min-max-detalle').textContent = `Mín: ${(minSec / 60).toFixed(1)} min | Máx: ${(maxSec / 60).toFixed(1)} min`;

  // 2. Actualizar Aguja OEE Gauge (Meta 15 baches/h)
  animateOeeGauge(avgBph, avgTph);

  // 3. Renderizar Gráfica de Productividad por Bache
  renderProductivityChart(chartPoints);

  // 4. Renderizar Tabla de Productividad
  renderProductivityTable(enrichedRows);
}

// Plugin inline para dibujar etiquetas numéricas sobre las barras en Chart.js
const chartDataLabelsPlugin = {
  id: 'chartDataLabels',
  afterDatasetsDraw(chart, args, options) {
    if (!options || options.enabled === false) return;
    const { ctx } = chart;
    ctx.save();

    chart.data.datasets.forEach((dataset, datasetIdx) => {
      if (dataset.type === 'line') return;

      const meta = chart.getDatasetMeta(datasetIdx);
      if (meta.hidden) return;

      meta.data.forEach((element, index) => {
        const val = dataset.data[index];
        if (val === null || val === undefined || val <= 0) return;

        let label = options.formatter ? options.formatter(val, index) : String(val);
        ctx.fillStyle = options.color || '#ffffff';
        ctx.font = options.font || 'bold 9.5px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        let yPos = element.y - 3;
        if (yPos < 14) yPos = element.y + 13;

        ctx.fillText(label, element.x, yPos);
      });
    });

    ctx.restore();
  }
};

// Renderizar Gráfica de Productividad (Bar per batch + Moving average line)
function renderProductivityChart(points) {
  const ctx = document.getElementById('chart-productividad-baches');
  if (!ctx) return;

  const labels = points.map(p => `#${p.Numero_Bache}`);
  const bphData = points.map(p => p.Baches_Hora);
  const movilData = points.map(p => p.Baches_Hora_Movil);
  const showBarLabels = points.length <= 45; // Mostrar números si son <= 45 baches

  if (AppState.charts.prod) AppState.charts.prod.destroy();

  AppState.charts.prod = new Chart(ctx, {
    type: 'bar',
    plugins: [chartDataLabelsPlugin],
    data: {
      labels: labels,
      datasets: [
        {
          type: 'line',
          label: '🎯 Meta OEE (12 b/h)',
          data: labels.map(() => 12.0),
          borderColor: '#ffd700',
          borderWidth: 1.8,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
          order: 0
        },
        {
          type: 'line',
          label: `Media Móvil (${AppState.movingAverageWindow} baches)`,
          data: movilData,
          borderColor: '#2ECC71',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.35,
          order: 1
        },
        {
          type: 'bar',
          label: 'Baches / Hora Instantáneo',
          data: bphData,
          backgroundColor: 'rgba(52, 152, 219, 0.75)',
          borderColor: '#3498db',
          borderWidth: 1,
          borderRadius: 3,
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: '#8b949e', font: { size: 11 } }
        },
        chartDataLabels: {
          enabled: showBarLabels,
          color: '#ffffff',
          font: 'bold 9.5px system-ui, sans-serif',
          formatter: (v) => v.toFixed(2)
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              const p = points[idx];
              return `OP ${p.OP} | Tarea: ${p.Tarea} | Bache #${p.Numero_Bache}`;
            },
            afterBody: (items) => {
              const idx = items[0].dataIndex;
              const p = points[idx];
              return [
                `Fórmula: ${p.Nombre_Formula}`,
                `Peso Real: ${p.PesoReal.toFixed(2)} kg`,
                `Duración: ${p.DuracionFormateada || p.Duracion || '-'}`,
                `Baches/Hora: ${p.Baches_Hora.toFixed(2)} /h`,
                `Media Móvil: ${p.Baches_Hora_Movil.toFixed(2)} /h`,
                `Ton/Hora: ${p.Ton_Hora.toFixed(2)} T/h`,
                `Fecha: ${p.Fecha_Fin || p.Fecha_Inicio}`
              ];
            }
          }
        }
      },
      scales: {
        y: {
          max: 16.0,
          min: 0,
          grid: { color: 'rgba(48, 54, 61, 0.4)' },
          ticks: {
            stepSize: 3,
            color: '#8b949e',
            callback: (v) => `${v} /h`
          }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#8b949e', maxRotation: 0 }
        }
      }
    }
  });
}

// Renderizar Tabla de Productividad
function renderProductivityTable(rows) {
  const tbody = document.getElementById('tabla-productividad-body');
  const countLabel = document.getElementById('txt-total-filas-prod');
  const pageIndicator = document.getElementById('page-indicator-prod');
  const btnPrev = document.getElementById('btn-prev-prod');
  const btnNext = document.getElementById('btn-next-prod');

  if (!tbody) return;

  // Ordenar según checkbox (por defecto Fecha Fin DESC)
  let displayRows = [...rows];
  if (AppState.sortByTask) {
    displayRows.sort((a, b) => b.OP - a.OP || b.Tarea.localeCompare(a.Tarea) || b.Numero_Bache - a.Numero_Bache);
  } else {
    displayRows.sort((a, b) => new Date(b.Fecha_Fin || b.Fecha_Inicio || 0) - new Date(a.Fecha_Fin || a.Fecha_Inicio || 0));
  }

  if (displayRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center empty-state">No se encontraron registros de productividad.</td></tr>`;
    if (countLabel) countLabel.textContent = 'Total registros: 0';
    if (pageIndicator) pageIndicator.textContent = 'Página 1 de 1';
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
    return;
  }

  const totalPages = Math.ceil(displayRows.length / CONFIG.PAGE_SIZE_PROD);
  AppState.pageProd = Math.min(AppState.pageProd, totalPages);

  const startIdx = (AppState.pageProd - 1) * CONFIG.PAGE_SIZE_PROD;
  const endIdx = startIdx + CONFIG.PAGE_SIZE_PROD;
  const pageRows = displayRows.slice(startIdx, endIdx);

  tbody.innerHTML = pageRows.map(r => {
    return `
      <tr>
        <td><strong>${escapeHtml(r.OP)}</strong></td>
        <td>${escapeHtml(r.Tarea)}</td>
        <td class="text-right">#${r.Numero_Bache}</td>
        <td>${escapeHtml(r.Codigo_Formula)}</td>
        <td>${escapeHtml(r.Nombre_Formula)}</td>
        <td class="text-right">${r.PesoMeta.toFixed(2)} kg</td>
        <td class="text-right"><strong>${r.PesoReal.toFixed(2)} kg</strong></td>
        <td>${escapeHtml(r.DuracionFormateada || r.Duracion || '-')}</td>
        <td class="text-right text-blue">${r.Baches_Hora > 0 ? r.Baches_Hora.toFixed(2) + ' /h' : '---'}</td>
        <td class="text-right text-gold">${r.Ton_Hora > 0 ? r.Ton_Hora.toFixed(2) + ' T/h' : '---'}</td>
        <td><span class="badge ${r.Estado === 'Finalizado' ? 'badge-success' : 'badge-warning'}">${escapeHtml(r.Estado)}</span></td>
        <td>${escapeHtml(r.Fecha_Fin || r.Fecha_Inicio)}</td>
      </tr>
    `;
  }).join('');

  if (countLabel) countLabel.textContent = `Mostrando ${startIdx + 1}-${Math.min(endIdx, displayRows.length)} de ${displayRows.length} registros`;
  if (pageIndicator) pageIndicator.textContent = `Página ${AppState.pageProd} de ${totalPages}`;
  if (btnPrev) btnPrev.disabled = AppState.pageProd <= 1;
  if (btnNext) btnNext.disabled = AppState.pageProd >= totalPages;
}

// =============================================================================
// 8. OEE SPEEDOMETER GAUGE CANVAS COMPONENT
// =============================================================================
function initGaugeCanvas() {
  drawOeeGauge(0.0);
}

function animateOeeGauge(targetBph, targetTph) {
  AppState.gaugeTarget = Math.min(15.0, Math.max(0, targetBph));
  const startTime = performance.now();
  const startVal = AppState.gaugeValue;
  const duration = 600; // ms

  if (AppState.gaugeAnimationId) cancelAnimationFrame(AppState.gaugeAnimationId);

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    AppState.gaugeValue = startVal + (AppState.gaugeTarget - startVal) * ease;

    drawOeeGauge(AppState.gaugeValue);

    if (progress < 1) {
      AppState.gaugeAnimationId = requestAnimationFrame(step);
    } else {
      AppState.gaugeValue = AppState.gaugeTarget;
      drawOeeGauge(AppState.gaugeValue);
    }
  }

  AppState.gaugeAnimationId = requestAnimationFrame(step);

  // Actualizar lectura digital y estado OEE (12 baches/hora = 100%)
  document.getElementById('gauge-bph-val').textContent = targetBph.toFixed(2);
  document.getElementById('gauge-tph-val').textContent = `${targetTph.toFixed(2)} Ton/h`;

  const oeePct = Math.round((targetBph / 12.0) * 100);
  const oeeBadge = document.getElementById('gauge-oee-status');
  if (oeeBadge) {
    oeeBadge.textContent = `OEE: ${oeePct}%`;
    if (targetBph >= 10.0) {
      oeeBadge.style.background = 'rgba(46, 204, 113, 0.4)';
    } else if (targetBph >= 6.0) {
      oeeBadge.style.background = 'rgba(243, 156, 18, 0.4)';
    } else {
      oeeBadge.style.background = 'rgba(231, 76, 60, 0.4)';
    }
  }
}

function drawOeeGauge(value) {
  const canvas = document.getElementById('gauge-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h - 6;
  const r = 52;
  const lineWidth = 10;

  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;

  // 1. Fondo de arco base
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle, false);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.stroke();

  // 2. Segmentos de Colores (0-6 Rojo, 6-10 Amarillo, 10-15 Verde)
  const angle0 = Math.PI;
  const angle6 = Math.PI + (6 / 15) * Math.PI;
  const angle10 = Math.PI + (10 / 15) * Math.PI;
  const angle15 = 2 * Math.PI;

  // Segmento Rojo (0 a 6 b/h -> < 50% OEE)
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle0, angle6, false);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#e74c3c';
  ctx.stroke();

  // Segmento Amarillo (6 a 10 b/h -> 50% a 83% OEE)
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle6, angle10, false);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#f39c12';
  ctx.stroke();

  // Segmento Verde (10 a 15 b/h -> >= 83% OEE, pasando por 12 b/h que es 100%)
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle10, angle15, false);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#2ecc71';
  ctx.stroke();

  // 3. Marcas de graduación (Ticks 0, 3, 6, 9, 12 [100% Target], 15)
  for (let i = 0; i <= 15; i += 3) {
    const isTarget100 = (i === 12);
    const tickAngle = Math.PI + (i / 15) * Math.PI;
    const lenInner = isTarget100 ? 9 : 7;
    const lenOuter = isTarget100 ? 9 : 7;
    const x1 = cx + (r - lenInner) * Math.cos(tickAngle);
    const y1 = cy + (r - lenInner) * Math.sin(tickAngle);
    const x2 = cx + (r + lenOuter) * Math.cos(tickAngle);
    const y2 = cy + (r + lenOuter) * Math.sin(tickAngle);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineWidth = isTarget100 ? 2.5 : 1.8;
    ctx.strokeStyle = isTarget100 ? '#ffd700' : '#ffffff';
    ctx.stroke();
  }

  // 4. Aguja Indicadora (Needle)
  const clampedVal = Math.min(15.0, Math.max(0, value));
  const needleAngle = Math.PI + (clampedVal / 15.0) * Math.PI;
  const needleLength = r - 4;

  const nx = cx + needleLength * Math.cos(needleAngle);
  const ny = cy + needleLength * Math.sin(needleAngle);

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(nx, ny);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Centro de la aguja (pivote)
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// =============================================================================
// 9. CÁLCULO Y RENDERIZADO CONSOLIDADO (TAB 2)
// =============================================================================
function processConsolidatedAndRender(baches) {
  const groupingMode = AppState.groupingModeCons;
  const chartMetric = AppState.metricCons;

  const validRows = baches.filter(b => b.Fecha_Fin || b.Fecha_Inicio)
    .sort((a, b) => new Date(a.Fecha_Fin || a.Fecha_Inicio || 0) - new Date(b.Fecha_Fin || b.Fecha_Inicio || 0));

  const groupsDict = new Map();

  for (const b of validRows) {
    const dt = new Date((b.Fecha_Fin || b.Fecha_Inicio).replace(' ', 'T'));
    const tInfo = obtenerInfoTurno(dt);
    const fOp = tInfo.fechaOperativa;

    let groupKey = '';
    let pLabel = '';
    let pTurno = 'Todos los Turnos';
    let sortDate = fOp;

    if (groupingMode === 0) { // Por Día
      groupKey = fOp.toISOString().split('T')[0];
      pLabel = groupKey;
      sortDate = fOp;
    } else if (groupingMode === 1) { // Por Semana
      const weekNumber = getWeekNumber(fOp);
      groupKey = `${fOp.getFullYear()}-W${weekNumber.toString().padStart(2, '0')}`;
      pLabel = `Sem. ${weekNumber} (${fOp.getFullYear()})`;
      sortDate = fOp;
    } else if (groupingMode === 2) { // Por Mes
      groupKey = fOp.toISOString().substring(0, 7);
      pLabel = groupKey;
      sortDate = new Date(fOp.getFullYear(), fOp.getMonth(), 1);
    } else if (groupingMode === 3) { // Por Turno
      groupKey = `T${tInfo.turnoNumero}`;
      pLabel = tInfo.turnoNombre;
      pTurno = tInfo.turnoNombre;
      sortDate = new Date(2000, 0, tInfo.turnoNumero);
    } else if (groupingMode === 4) { // Por Día y Turno
      const dayStr = fOp.toISOString().split('T')[0];
      groupKey = `${dayStr}-T${tInfo.turnoNumero}`;
      pLabel = `${dayStr} (T${tInfo.turnoNumero})`;
      pTurno = tInfo.turnoNombre;
      sortDate = fOp;
    }

    if (!groupsDict.has(groupKey)) {
      groupsDict.set(groupKey, { key: groupKey, label: pLabel, turno: pTurno, sortDate: sortDate, baches: [] });
    }
    groupsDict.get(groupKey).baches.push(b);
  }

  // Consolidar métricas para cada grupo
  const consolidatedRows = Array.from(groupsDict.values()).map(g => {
    const totalB = g.baches.length;
    const pesoMetaKg = g.baches.reduce((a, b) => a + (b.PesoMeta || 0), 0);
    const pesoRealKg = g.baches.reduce((a, b) => a + (b.PesoReal || 0), 0);
    const pesoMetaTon = pesoMetaKg / 1000.0;
    const pesoRealTon = pesoRealKg / 1000.0;
    const desvKg = pesoRealKg - pesoMetaKg;

    const totalDurSec = g.baches.reduce((a, b) => a + parseDurationToSeconds(b.Duracion, b.Fecha_Inicio, b.Fecha_Fin), 0);
    const avgSecPerBache = totalB > 0 ? (totalDurSec / totalB) : 0;

    const bph = avgSecPerBache > 10 ? Math.round((3600.0 / avgSecPerBache) * 100) / 100 : 0.0;
    const tph = Math.round((pesoRealTon * (totalDurSec > 0 ? (3600.0 / totalDurSec) : 0)) * 100) / 100;

    const uniqueOPs = new Set(g.baches.map(b => b.OP).filter(Boolean)).size;
    const uniqueFormulas = new Set(g.baches.map(b => b.Nombre_Formula).filter(Boolean)).size;

    return {
      Periodo: g.label,
      Turno: g.turno,
      Total_Baches: totalB,
      Peso_Meta_Ton: pesoMetaTon,
      Peso_Real_Ton: pesoRealTon,
      Desviacion_Kg: desvKg,
      Tiempo_Total_Str: formatSeconds(totalDurSec),
      Prom_Por_Bache_Str: `${Math.floor(avgSecPerBache / 60)}m ${Math.floor(avgSecPerBache % 60)}s`,
      Baches_Hora: bph,
      Ton_Hora: tph,
      Cant_OPs: uniqueOPs,
      Cant_Formulas: uniqueFormulas,
      SortDate: g.sortDate
    };
  });

  // Ordenar cronológicamente
  consolidatedRows.sort((a, b) => new Date(a.SortDate) - new Date(b.SortDate));

  // 1. Renderizar Gráfica Consolidada
  renderConsolidatedChart(consolidatedRows, chartMetric);

  // 2. Renderizar Tabla Consolidada
  renderConsolidatedTable(consolidatedRows);
}

function renderConsolidatedChart(rows, metricMode) {
  const ctx = document.getElementById('chart-consolidado-canvas');
  if (!ctx) return;

  const labels = rows.map(r => r.Periodo);
  let labelFormatter = (v) => `${v}`;
  if (metricMode === 0) {
    datasetLabel = 'Baches Totales';
    dataValues = rows.map(r => r.Total_Baches);
    color = '#3498db';
    labelFormatter = (v) => `${v}`;
  } else if (metricMode === 1) {
    datasetLabel = 'Toneladas Totales (Ton)';
    dataValues = rows.map(r => r.Peso_Real_Ton);
    color = '#f39c12';
    labelFormatter = (v) => `${v.toFixed(1)} T`;
  } else if (metricMode === 2) {
    datasetLabel = 'Baches / Hora';
    dataValues = rows.map(r => r.Baches_Hora);
    color = '#2ecc71';
    labelFormatter = (v) => `${v.toFixed(2)} /h`;
  } else if (metricMode === 3) {
    datasetLabel = 'Toneladas / Hora (Ton/h)';
    dataValues = rows.map(r => r.Ton_Hora);
    color = '#9b59b6';
    labelFormatter = (v) => `${v.toFixed(2)} T/h`;
  }

  if (AppState.charts.cons) AppState.charts.cons.destroy();

  AppState.charts.cons = new Chart(ctx, {
    type: 'bar',
    plugins: [chartDataLabelsPlugin],
    data: {
      labels: labels,
      datasets: [{
        label: datasetLabel,
        data: dataValues,
        backgroundColor: color,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        chartDataLabels: {
          enabled: true,
          color: '#ffffff',
          font: 'bold 10px system-ui, sans-serif',
          formatter: labelFormatter
        }
      },
      scales: {
        y: {
          grace: '12%',
          grid: { color: 'rgba(48, 54, 61, 0.4)' },
          ticks: { color: '#8b949e' }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#8b949e', maxRotation: 30 }
        }
      }
    }
  });
}

function renderConsolidatedTable(rows) {
  const tbody = document.getElementById('tabla-consolidado-body');
  const countLabel = document.getElementById('txt-total-filas-cons');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center empty-state">Sin datos consolidados para el período.</td></tr>`;
    if (countLabel) countLabel.textContent = 'Total registros: 0';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.Periodo)}</strong></td>
      <td>${escapeHtml(r.Turno)}</td>
      <td class="text-right text-blue">${r.Total_Baches}</td>
      <td class="text-right">${r.Peso_Meta_Ton.toFixed(2)} Ton</td>
      <td class="text-right text-gold"><strong>${r.Peso_Real_Ton.toFixed(2)} Ton</strong></td>
      <td class="text-right">${r.Desviacion_Kg > 0 ? '+' : ''}${r.Desviacion_Kg.toFixed(2)} kg</td>
      <td>${escapeHtml(r.Tiempo_Total_Str)}</td>
      <td>${escapeHtml(r.Prom_Por_Bache_Str)}</td>
      <td class="text-right text-green"><strong>${r.Baches_Hora.toFixed(2)} /h</strong></td>
      <td class="text-right text-purple">${r.Ton_Hora.toFixed(2)} T/h</td>
      <td class="text-right">${r.Cant_OPs}</td>
      <td class="text-right">${r.Cant_Formulas}</td>
    </tr>
  `).join('');

  if (countLabel) countLabel.textContent = `Total registros agrupados: ${rows.length}`;
}

// =============================================================================
// 10. TABLA GENERAL DE BACHES (TAB 3)
// =============================================================================
function renderBachesTable(baches) {
  const tbody = document.getElementById('baches-table-body');
  const countLabel = document.getElementById('table-record-count');
  const pageIndicator = document.getElementById('page-indicator');
  const btnPrev = document.getElementById('btn-prev-page');
  const btnNext = document.getElementById('btn-next-page');

  if (!tbody) return;

  // Ordenar Fecha Fin DESC
  const sorted = [...baches].sort((a, b) => new Date(b.Fecha_Fin || b.Fecha_Inicio || 0) - new Date(a.Fecha_Fin || a.Fecha_Inicio || 0));

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center empty-state">No se encontraron baches.</td></tr>`;
    if (countLabel) countLabel.textContent = 'Mostrando 0 baches';
    if (pageIndicator) pageIndicator.textContent = 'Página 1 de 1';
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
    return;
  }

  const totalPages = Math.ceil(sorted.length / CONFIG.PAGE_SIZE_BACHES);
  AppState.pageBaches = Math.min(AppState.pageBaches, totalPages);

  const startIdx = (AppState.pageBaches - 1) * CONFIG.PAGE_SIZE_BACHES;
  const endIdx = startIdx + CONFIG.PAGE_SIZE_BACHES;
  const pageItems = sorted.slice(startIdx, endIdx);

  tbody.innerHTML = pageItems.map(b => {
    const dev = b.Desviacion_Peso || 0;
    const devClass = Math.abs(dev) > 5 ? 'badge-danger' : Math.abs(dev) > 1.5 ? 'badge-warning' : 'badge-success';

    return `
      <tr>
        <td><strong>${escapeHtml(b.OP)}</strong></td>
        <td>${escapeHtml(b.Tarea)}</td>
        <td class="text-right">#${b.Numero_Bache}</td>
        <td>${escapeHtml(b.Codigo_Formula)}</td>
        <td>${escapeHtml(b.Nombre_Formula)}</td>
        <td class="text-right">v${b.Version}</td>
        <td class="text-right">${b.PesoMeta.toFixed(2)}</td>
        <td class="text-right"><strong>${b.PesoReal.toFixed(2)}</strong></td>
        <td class="text-right"><span class="badge ${devClass}">${dev > 0 ? '+' : ''}${dev.toFixed(2)}</span></td>
        <td><span class="badge ${b.Estado === 'Finalizado' ? 'badge-success' : 'badge-warning'}">${escapeHtml(b.Estado)}</span></td>
        <td>${escapeHtml(b.Fecha_Fin || b.Fecha_Inicio)}</td>
        <td>${escapeHtml(b.Duracion || '-')}</td>
      </tr>
    `;
  }).join('');

  if (countLabel) countLabel.textContent = `Mostrando ${startIdx + 1}-${Math.min(endIdx, sorted.length)} de ${sorted.length} baches`;
  if (pageIndicator) pageIndicator.textContent = `Página ${AppState.pageBaches} de ${totalPages}`;
  if (btnPrev) btnPrev.disabled = AppState.pageBaches <= 1;
  if (btnNext) btnNext.disabled = AppState.pageBaches >= totalPages;
}

function populateFormulaFilter() {
  const select = document.getElementById('filter-formula');
  if (!select) return;

  const formulas = Array.from(new Set(AppState.allBaches.map(b => b.Nombre_Formula).filter(Boolean))).sort();
  select.innerHTML = '<option value="">Todas las Fórmulas</option>' + 
    formulas.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
}

// =============================================================================
// 11. EXPORTACIONES (EXCEL / CSV)
// =============================================================================
function exportTableToExcel(data, fileName, sheetTitle = 'Datos') {
  if (!data || data.length === 0) {
    showToast('No hay datos para exportar.', 'info');
    return;
  }
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
  XLSX.writeFile(wb, `${fileName}_${new Date().toISOString().split('T')[0]}.xlsx`);
  showToast(`Excel exportado correctamente`, 'success');
}

function exportTableToCsv(data, fileName) {
  if (!data || data.length === 0) {
    showToast('No hay datos para exportar.', 'info');
    return;
  }
  const headers = Object.keys(data[0]);
  const rows = data.map(row => headers.map(h => `"${row[h] || ''}"`).join(','));
  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `${fileName}_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('CSV exportado correctamente', 'success');
}

// =============================================================================
// 12. LISTENERS Y EVENTOS DE INTERFAZ
// =============================================================================
function initEventListeners() {
  // Tabs Navigation
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      const targetTab = tab.getAttribute('data-tab');
      tab.classList.add('active');
      const pane = document.getElementById(`tab-${targetTab}`);
      if (pane) pane.classList.add('active');
    });
  });

  // Filtros de Período (Pills)
  document.querySelectorAll('#period-filters .pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#period-filters .pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      AppState.currentPeriod = btn.getAttribute('data-period');
      applyFiltersAndRender();
    });
  });

  // Selector de Turnos
  const selectTurno = document.getElementById('select-turno');
  if (selectTurno) {
    selectTurno.addEventListener('change', (e) => {
      AppState.selectedTurno = parseInt(e.target.value, 10);
      applyFiltersAndRender();
    });
  }

  // Filtro Rango Personalizado
  document.getElementById('btn-apply-dates')?.addEventListener('click', () => {
    document.querySelectorAll('#period-filters .pill-btn').forEach(b => b.classList.remove('active'));
    AppState.currentPeriod = 'custom';
    AppState.customDateFrom = document.getElementById('date-from')?.value;
    AppState.customDateTo = document.getElementById('date-to')?.value;
    applyFiltersAndRender();
  });

  // Selector de Ventana Móvil
  document.getElementById('select-ventana-movil')?.addEventListener('change', (e) => {
    AppState.movingAverageWindow = parseInt(e.target.value, 10);
    applyFiltersAndRender();
  });

  // Checkbox Ordenar por Tarea
  document.getElementById('chk-ordenar-tarea')?.addEventListener('change', (e) => {
    AppState.sortByTask = e.target.checked;
    applyFiltersAndRender();
  });

  // Selectores Consolidado
  document.getElementById('select-agrupacion-cons')?.addEventListener('change', (e) => {
    AppState.groupingModeCons = parseInt(e.target.value, 10);
    applyFiltersAndRender();
  });

  document.getElementById('select-metrica-cons')?.addEventListener('change', (e) => {
    AppState.metricCons = parseInt(e.target.value, 10);
    applyFiltersAndRender();
  });

  // Toggle Gráficas
  document.getElementById('btn-toggle-grafica-prod')?.addEventListener('click', () => {
    const pnl = document.getElementById('pnl-chart-prod');
    const txt = document.getElementById('txt-toggle-grafica-prod');
    if (pnl.style.display === 'none') {
      pnl.style.display = 'block';
      txt.textContent = 'Ocultar Gráfica';
    } else {
      pnl.style.display = 'none';
      txt.textContent = 'Mostrar Gráfica';
    }
  });

  document.getElementById('btn-toggle-grafica-cons')?.addEventListener('click', () => {
    const pnl = document.getElementById('pnl-chart-cons');
    const txt = document.getElementById('txt-toggle-grafica-cons');
    if (pnl.style.display === 'none') {
      pnl.style.display = 'block';
      txt.textContent = 'Ocultar Gráfica';
    } else {
      pnl.style.display = 'none';
      txt.textContent = 'Mostrar Gráfica';
    }
  });

  // Búsqueda en Baches
  document.getElementById('table-search')?.addEventListener('input', (e) => {
    AppState.searchTerm = e.target.value.trim();
    applyFiltersAndRender();
  });

  document.getElementById('filter-formula')?.addEventListener('change', (e) => {
    AppState.selectedFormula = e.target.value;
    applyFiltersAndRender();
  });

  // Paginación Productividad
  document.getElementById('btn-prev-prod')?.addEventListener('click', () => {
    if (AppState.pageProd > 1) {
      AppState.pageProd--;
      applyFiltersAndRender();
    }
  });
  document.getElementById('btn-next-prod')?.addEventListener('click', () => {
    AppState.pageProd++;
    applyFiltersAndRender();
  });

  // Paginación Baches
  document.getElementById('btn-prev-page')?.addEventListener('click', () => {
    if (AppState.pageBaches > 1) {
      AppState.pageBaches--;
      applyFiltersAndRender();
    }
  });
  document.getElementById('btn-next-page')?.addEventListener('click', () => {
    AppState.pageBaches++;
    applyFiltersAndRender();
  });

  // Exportaciones
  document.getElementById('btn-export-prod-excel')?.addEventListener('click', () => {
    exportTableToExcel(AppState.filteredBaches, 'KIKES_Productividad', 'Productividad');
  });
  document.getElementById('btn-export-prod-csv')?.addEventListener('click', () => {
    exportTableToCsv(AppState.filteredBaches, 'KIKES_Productividad');
  });
  document.getElementById('btn-export-excel')?.addEventListener('click', () => {
    exportTableToExcel(AppState.filteredBaches, 'KIKES_Resumen_Baches', 'Baches');
  });
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    exportTableToCsv(AppState.filteredBaches, 'KIKES_Resumen_Baches');
  });

  // Botón Refresh y Login
  document.getElementById('btn-refresh')?.addEventListener('click', () => syncDataFromGoogleDrive());
  document.getElementById('btn-google-login')?.addEventListener('click', loginWithGoogle);
  document.getElementById('btn-logout-google')?.addEventListener('click', logoutGoogle);
  document.getElementById('btn-clear-cache')?.addEventListener('click', () => {
    localStorage.removeItem(CONFIG.STORAGE_KEYS.CACHED_BACHES);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.LAST_SYNC);
    AppState.allBaches = [];
    applyFiltersAndRender();
    showToast('Caché limpiada.', 'info');
    syncDataFromGoogleDrive();
  });
  document.getElementById('user-profile-btn')?.addEventListener('click', () => {
    document.querySelector('.nav-tab[data-tab="configuracion"]')?.click();
  });
}

// =============================================================================
// 13. HELPERS Y UTILIDADES
// =============================================================================
function formatSeconds(totalSecs) {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
