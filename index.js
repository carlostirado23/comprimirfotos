const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// Configuración de directorios
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'paquetes');

// Asegurar carpetas
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(express.json());
app.use(cors()); // Habilitar CORS para n8n

// Configuración de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB por archivo
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|pdf|zip/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Solo se permiten archivos de imagen, PDF o ZIP'));
  }
}).array('files', 10); // Cambiado a 'files' para mejor compatibilidad

// Función para comprimir archivos a ZIP
async function createZip(files, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`Archivo ZIP creado: ${outputPath} (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on('error', (err) => {
      console.error('Error al crear el archivo ZIP:', err);
      reject(err);
    });

    archive.pipe(output);
    
    files.forEach(file => {
      const fileName = file.originalname || path.basename(file.path);
      archive.file(file.path, { name: fileName });
    });

    archive.finalize();
  });
}

// Limpiar archivos temporales
function cleanupFiles(files) {
  files.forEach(file => {
    fs.unlink(file.path, err => {
      if (err) console.error('Error al eliminar archivo temporal:', err);
    });
  });
}

// Ruta principal
app.get('/', (req, res) => {
  res.json({
    status: 'active',
    endpoints: {
      upload: 'POST /comprimir',
      description: 'Sube archivos para comprimir en un ZIP',
      parameters: {
        files: 'Array de archivos (máx 10)',
        response: 'Archivo ZIP descargable o URL de descarga'
      }
    }
  });
});

// Ruta para subir y comprimir archivos
app.post('/comprimir', (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ 
        success: false,
        error: err.message || 'Error al procesar los archivos',
        code: 'UPLOAD_ERROR'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'No se han subido archivos',
        code: 'NO_FILES'
      });
    }

    try {
      const timestamp = Date.now();
      const zipFilename = `archivos-${timestamp}.zip`;
      const zipPath = path.join(OUTPUT_DIR, zipFilename);
      
      // Crear archivo ZIP
      await createZip(req.files, zipPath);
      
      // URL para descargar el archivo
      const downloadUrl = `/descargar/${zipFilename}`;
      
      // Limpiar archivos temporales después de un tiempo
      setTimeout(() => cleanupFiles(req.files), 5000);
      
      // Respuesta para n8n
      res.json({
        success: true,
        message: 'Archivos comprimidos exitosamente',
        downloadUrl: downloadUrl,
        filename: zipFilename,
        fileCount: req.files.length
      });
      
    } catch (error) {
      console.error('Error en el proceso de compresión:', error);
      res.status(500).json({ 
        success: false,
        error: 'Error al procesar los archivos',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
        code: 'COMPRESSION_ERROR'
      });
    }
  });
});

// Ruta para descargar el archivo ZIP
app.get('/descargar/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      error: 'Archivo no encontrado',
      code: 'FILE_NOT_FOUND'
    });
  }
  
  res.download(filePath, req.params.filename, (err) => {
    if (err) {
      console.error('Error al descargar el archivo:', err);
      res.status(500).json({
        success: false,
        error: 'Error al descargar el archivo',
        code: 'DOWNLOAD_ERROR'
      });
    }
    
    // Opcional: eliminar el archivo después de descargarlo
    // fs.unlink(filePath, err => {
    //   if (err) console.error('Error al eliminar archivo ZIP:', err);
    // });
  });
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    code: 'INTERNAL_ERROR',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Iniciar el servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`Archivos temporales en: ${UPLOAD_DIR}`);
  console.log(`Archivos ZIP en: ${OUTPUT_DIR}`);
});

module.exports = app;
