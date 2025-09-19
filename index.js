const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 4000;

const ROOT = "/tmp";
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "paquetes");

// Asegurar carpetas
for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json());

// ===== Sesiones por chatId =====
/** sessions: Map<chatId, {files: string[], createdAt: number}> */
const sessions = new Map();
function ensureSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { files: [], createdAt: Date.now() });
  return sessions.get(chatId);
}
function getChatId(req) {
  return (req.body?.chatId || req.query?.chatId || "default").toString();
}

// ===== Multer con subcarpeta por chatId =====
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const chatId = getChatId(req);
      const dir = path.join(UPLOAD_DIR, chatId);
      await fsp.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage });

// ===== Helpers =====
async function compressZIP(outPath, files) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    files.forEach((f) => archive.file(f, { name: path.basename(f) }));
    archive.finalize();
  });
}

// ===== Rutas =====

// Salud
app.get("/", (_req, res) => res.send("OK"));

// Iniciar (GET o POST) -> limpia la sesión del chatId
app.all("/iniciar", (req, res) => {
  const chatId = getChatId(req);
  sessions.set(chatId, { files: [], createdAt: Date.now() });
  return res.json({
    ok: true,
    message: `Sesión iniciada para chatId=${chatId}. Envía las fotos con /upload.`,
  });
});

// Subir fotos (multipart) campo 'fotos' (1..N). Requiere chatId
app.post("/upload", upload.array("fotos"), (req, res) => {
  const chatId = getChatId(req);
  const s = ensureSession(chatId);
  const saved = (req.files || []).map((f) => f.path);
  s.files.push(...saved);
  return res.json({
    ok: true,
    chatId,
    recibidasAhora: saved.length,
    totalSesion: s.files.length,
  });
});

// Comprimir (GET o POST). Devuelve descarga directa del ZIP
app.all("/comprimir", async (req, res) => {
  const chatId = getChatId(req);
  const s = ensureSession(chatId);

  if (!s.files.length) {
    return res.status(400).json({ ok: false, error: "No hay fotos cargadas para este chatId." });
  }

  const outName = `fotos_${chatId}_${Date.now()}.zip`;
  const outPath = path.join(OUTPUT_DIR, outName);

  try {
    await compressZIP(outPath, s.files);
    // Limpia la sesión (si prefieres conservar, comenta la línea siguiente)
    sessions.delete(chatId);
    return res.download(outPath, outName, (err) => {
      if (err) console.error("Error enviando ZIP:", err);
    });
  } catch (e) {
    console.error("ZIP error:", e);
    return res.status(500).json({ ok: false, error: "No se pudo generar el ZIP." });
  }
});

app.listen(PORT, () => console.log(`🚀 API ZIP escuchando en http://localhost:${PORT}`));
