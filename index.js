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

// Ruta para el webhook de WhatsApp
app.get('/webhook/whatsapp', (req, res) => {
  // Verificación del webhook
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'tu_token_de_verificacion';
  
  // Verificar el token
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === verifyToken
  ) {
    console.log('Webhook verificado correctamente');
    return res.status(200).send(req.query['hub.challenge']);
  }
  
  console.error('Error en la verificación del webhook');
  return res.sendStatus(403);
});

// Manejar mensajes entrantes de WhatsApp
app.post('/webhook/whatsapp', express.json(), async (req, res) => {
  console.log('Webhook de WhatsApp recibido:', JSON.stringify(req.body, null, 2));
  
  // Verificar si es una actualización de estado de mensaje
  if (req.body.entry?.[0]?.changes?.[0]?.value?.statuses) {
    console.log('Actualización de estado de mensaje de WhatsApp:', 
      req.body.entry[0].changes[0].value.statuses[0]);
    return res.status(200).json({ status: 'ok' });
  }

  // Verificar si hay mensajes
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) {
    console.log('No se encontraron mensajes en el webhook');
    return res.status(200).json({ status: 'ok' });
  }

  try {
    // Si es un mensaje con archivo adjunto
    if (message.type === 'image' || message.type === 'document') {
      console.log('Mensaje con archivo adjunto recibido:', message.type);
      
      // Obtener información del archivo
      const mediaType = message.type;
      const mediaId = message[mediaType]?.id;
      const mimeType = message[mediaType]?.mime_type || 
                      (mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream');
      const fileExt = mediaType === 'image' ? 'jpg' : 
                     message[mediaType]?.filename?.split('.').pop() || 'bin';
      
      if (!mediaId) {
        console.error('ID de archivo no encontrado en el mensaje');
        return res.status(400).json({ 
          success: false, 
          error: 'ID de archivo no encontrado' 
        });
      }

      // Crear un archivo temporal con la información del mensaje
      const fileName = `whatsapp-${Date.now()}.${fileExt}`;
      const filePath = path.join(UPLOAD_DIR, fileName);
      
      // Aquí deberías implementar la descarga del archivo de la API de WhatsApp
      // Por ahora, solo guardamos la información del mensaje
      const fileInfo = {
        fieldname: 'files',
        originalname: message[mediaType]?.filename || fileName,
        encoding: '7bit',
        mimetype: mimeType,
        destination: UPLOAD_DIR,
        filename: fileName,
        path: filePath,
        size: message[mediaType]?.file_size || 0,
        whatsappMediaId: mediaId,
        metadata: JSON.stringify({
          from: message.from,
          timestamp: message.timestamp,
          messageId: message.id
        })
      };

      // Guardar la información del archivo
      await fs.promises.writeFile(filePath, JSON.stringify(fileInfo, null, 2));
      console.log(`Archivo temporal creado: ${filePath}`);

      // Crear ZIP
      const timestamp = Date.now();
      const zipFilename = `whatsapp-${timestamp}.zip`;
      const zipPath = path.join(OUTPUT_DIR, zipFilename);
      
      await createZip([fileInfo], zipPath);
      
      // Construir URL de descarga
      const downloadUrl = `${req.protocol}://${req.get('host')}/descargar/${zipFilename}`;
      
      // Limpiar archivo temporal después de un tiempo
      setTimeout(() => {
        fs.unlink(filePath, err => {
          if (err) console.error('Error al eliminar archivo temporal:', err);
        });
      }, 5000);

      console.log('Archivo ZIP creado exitosamente:', zipPath);
      
      // Enviar respuesta a WhatsApp (opcional)
      // Aquí podrías implementar el envío de un mensaje de confirmación
      
      return res.json({
        success: true,
        message: 'Archivo recibido y procesado',
        downloadUrl: downloadUrl,
        filename: zipFilename,
        mediaType: mediaType,
        whatsappMessageId: message.id
      });
    }

    // Si es un mensaje de texto
    console.log('Mensaje de texto recibido:', message.text?.body);
    return res.json({ 
      success: true, 
      type: 'text',
      text: message.text?.body,
      message: 'Mensaje de texto recibido correctamente',
      whatsappMessageId: message.id
    });

  } catch (error) {
    console.error('Error en el webhook de WhatsApp:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Error al procesar el mensaje',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
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
