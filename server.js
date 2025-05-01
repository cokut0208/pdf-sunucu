// server.js
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chrome = require('@sparticuz/chromium');
const { createClient } = require('@supabase/supabase-js');

// Ortam Değişkenleri
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // GİZLİ TUT!
const storageBucketName = process.env.SUPABASE_BUCKET_NAME || 'generated-contracts';
const PORT = process.env.PORT || 3001;

// Supabase Client
if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Hata: Supabase URL veya Service Role Key ortam değişkenleri ayarlanmamış!");
    process.exit(1);
}
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
console.log("Supabase Admin Client başarıyla oluşturuldu.");

// Express Uygulaması
const app = express();

// Esnek CORS Ayarı (Tüm ceradijital.com.tr alt alan adları, localhost ve Netlify için)
app.use(cors({
    origin: function (origin, callback) {
        const allowedOriginPatterns = [
            /^http:\/\/localhost:\d+$/,
            /^https?:\/\/.*\.ceradijital\.com\.tr$/,
            /^https:\/\/.*\.netlify\.app$/,
            // Başka izin vermek istediğiniz adresler varsa buraya ekleyin
            // 'https://ornek-adres.com'
        ];
        let isAllowed = false;
        if (!origin) {
            isAllowed = true; // Tarayıcı dışı isteklere izin ver
        } else {
            for (const pattern of allowedOriginPatterns) {
                if (pattern instanceof RegExp && pattern.test(origin)) { isAllowed = true; break; }
                if (typeof pattern === 'string' && pattern === origin) { isAllowed = true; break; }
            }
        }
        if (isAllowed) { callback(null, true); }
        else { console.warn(`CORS Engellendi: Origin ${origin}`); callback(new Error('Bu origin için CORS politikası tarafından izin verilmiyor.')); }
    },
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Diğer Middleware'ler
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// Root Endpoint
app.get('/', (req, res) => res.status(200).send('CeraCRM PDF Generation Service is running!'));

// Ana PDF Oluşturma Endpoint'i
app.post('/api/generate-pdf', async (req, res) => {
    console.log("PDF oluşturma isteği alındı (/api/generate-pdf).");
    let browser = null;

    const { htmlContent, customerId, fileName: requestedFileName, headerData } = req.body;

    // --- Veri Doğrulama ---
    if (!htmlContent || !customerId || !requestedFileName || !headerData || !headerData.customerName || !headerData.templateName || !headerData.generationDate) {
        console.error("Hata: İstek body'sinde eksik veya hatalı veri.", { customerId, requestedFileName, headerDataExists: !!headerData });
        return res.status(400).json({ success: false, error: 'Eksik veya hatalı veri. htmlContent, customerId, fileName ve headerData (customerName, templateName, generationDate ile) zorunludur.' });
    }
    // Logo Data URI format kontrolü (varsa)
    if (headerData.logoDataUri && typeof headerData.logoDataUri === 'string' && !headerData.logoDataUri.startsWith('data:image/svg+xml;base64,')) {
       console.warn("Uyarı: headerData.logoDataUri geçerli bir Base64 SVG Data URI değil. Logo eklenemeyebilir.");
    }
    // Şirket bilgileri kontrolü (varsa, loglama için)
    // console.log("Şirket Bilgileri:", { name: headerData.companyName, addr: headerData.companyAddress });
    console.log(`İstek verileri doğrulandı. Müşteri ID: ${customerId}, Dosya Adı: ${requestedFileName}`);

    try {
        // --- Puppeteer Başlatma ---
        console.log("Puppeteer başlatılıyor...");
        const executablePath = process.env.CHROME_EXECUTABLE_PATH || (await chrome.executablePath());
        browser = await puppeteer.launch({
             args: chrome.args.concat(['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--hide-scrollbars', '--disable-web-security']),
             executablePath: executablePath,
             headless: chrome.headless,
             ignoreHTTPSErrors: true,
             dumpio: process.env.NODE_ENV !== 'production',
         });
        console.log("Puppeteer başarıyla başlatıldı.");

        const page = await browser.newPage();
        console.log("Yeni sayfa oluşturuldu.");

        // --- HTML İçeriğini Yükleme ---
        console.log("HTML içeriği sayfaya yükleniyor...");
        await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 60000 });
        console.log("HTML içeriği başarıyla yüklendi.");

        // --- Header ve Footer Şablonlarını Oluşturma ---
        const logoHtml = headerData.logoDataUri && typeof headerData.logoDataUri === 'string' && headerData.logoDataUri.startsWith('data:image/svg+xml;base64,')
           ? `<img src="${headerData.logoDataUri}" style="height: 40px; width: auto; max-width: 150px; vertical-align: middle;">`
           : '<span style="display: inline-block; width: 150px; height: 40px;"></span>'; // Logo yoksa veya geçersizse boşluk bırak

        // Şirket bilgilerini headerData'dan al (frontend göndermeli)
        const companyDetailsHtml = `
<div style="text-align: left; color: #333333; line-height: 1.4; font-size: 8px;">
   <div style="font-weight: bold; font-size: 10px; margin-bottom: 3px;">${headerData.companyName || 'Şirket Adı'}</div>
   <div>${headerData.companyAddress || 'Şirket Adresi'}</div>
   <div>Tel: ${headerData.companyPhone || ''} | E-posta: ${headerData.companyEmail || ''}</div>
   <div>Web: ${headerData.companyWebsite || ''}</div>
</div>`;

        // Müşteri ve Belge Bilgileri
        const documentDetailsHtml = `
<div style="text-align: right; color: #555555; line-height: 1.4; font-size: 9px;">
   <div style="font-weight: bold;">${headerData.customerName}</div>
   <div>${headerData.templateName}${headerData.projectName ? ` - ${headerData.projectName}` : ''}</div>
   <div>Oluşturma Tarihi: ${headerData.generationDate}</div>
</div>`;

        // Header'ı birleştirme
        const headerHtml = `
<div style="box-sizing: border-box; width: 100%; font-size: 9px; padding: 15px 50px 10px 50px; display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #cccccc; font-family: 'DejaVu Sans', Arial, sans-serif;">
   <div style="flex-shrink: 0; padding-right: 20px;">${logoHtml}</div>
   <div style="flex-grow: 1; display: flex; justify-content: space-between; align-items: flex-start;">
        ${companyDetailsHtml}
        ${documentDetailsHtml}
   </div>
</div>`;

       // Footer (Sayfa No Sağda, Metin Solda)
       const footerHtml = `
<div style="box-sizing: border-box; width: 100%; font-size: 8px; padding: 10px 50px 10px 50px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #cccccc; color: #777777; font-family: 'DejaVu Sans', Arial, sans-serif;">
   <span style="text-align: left;">İşbu sözleşme elektronik ortamda oluşturulmuştur.</span>
   <span style="text-align: right;">Sayfa <span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

        // --- PDF Oluşturma ---
        console.log("PDF buffer oluşturuluyor...");
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '85px', right: '50px', bottom: '60px', left: '50px' },
            displayHeaderFooter: true,
            headerTemplate: headerHtml,
            footerTemplate: footerHtml,
            preferCSSPageSize: true,
            timeout: 60000,
        });
        console.log(`PDF buffer başarıyla oluşturuldu (Boyut: ${pdfBuffer.length} bytes).`);

        // --- Tarayıcıyı Kapatma ---
        await browser.close();
        browser = null;
        console.log("Tarayıcı başarıyla kapatıldı.");

        // --- Supabase Storage'a Yükleme ---
        const filePath = `contracts/${customerId}/${requestedFileName}`;
        console.log(`PDF Supabase Storage'a yükleniyor: ${storageBucketName}/${filePath}`);
        const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
            .from(storageBucketName)
            .upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });

        if (uploadError) {
            console.error("Supabase Storage yükleme hatası:", uploadError);
             if (uploadError.message.includes('Bucket not found')) { throw new Error(`Supabase Storage Hatası: '${storageBucketName}' bucket bulunamadı.`); }
             if (uploadError.message.includes('Duplicate')) { throw new Error(`Supabase Storage Hatası: Bu isimde dosya zaten mevcut (${filePath}).`); }
            throw new Error(`Supabase Storage Hatası: ${uploadError.message}`);
        }
        console.log("PDF Supabase Storage'a başarıyla yüklendi. Path:", uploadData?.path);

        // --- Başarılı Yanıtı Döndürme ---
        res.status(200).json({ success: true, filePath: uploadData?.path });
        console.log("Başarılı yanıt (200) frontend'e gönderildi.");

    } catch (error) {
        // --- Hata Yönetimi ---
        console.error('PDF oluşturma/yükleme sürecinde kritik hata:', error);
        if (browser) {
            try { await browser.close(); } catch (closeError) { console.error("Hata sonrası tarayıcıyı kapatırken ek hata oluştu:", closeError); }
        }
        res.status(500).json({ success: false, error: error.message || 'PDF işlenirken sunucu hatası oluştu.' });
        console.log("Hata yanıtı (500) frontend'e gönderildi.");
    }
});

// --- Sunucuyu Başlatma ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CeraCRM PDF Sunucusu ${PORT} portunda başarıyla başlatıldı ve dinlemede...`);
    console.log(`➡️  Supabase URL: ${supabaseUrl}`);
    console.log(`🪣 Supabase Bucket: ${storageBucketName}`);
});

// Sinyal Yönetimi
process.on('SIGTERM', () => { console.log('SIGTERM sinyali alındı, sunucu kapatılıyor...'); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT sinyali alındı (Ctrl+C), sunucu kapatılıyor...'); process.exit(0); });