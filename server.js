// server.js
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chrome = require('@sparticuz/chromium'); // Sparticuz versiyonu
const { createClient } = require('@supabase/supabase-js');

// Ortam Değişkenleri (Environment Variables) - Render.com gibi platformlarda ayarlanmalı
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // BU ANAHTARI GİZLİ TUT!
const storageBucketName = process.env.SUPABASE_BUCKET_NAME || 'generated-contracts'; // Varsa bucket adı, yoksa varsayılan
const PORT = process.env.PORT || 3001; // Render.com genellikle portu kendi ayarlar

// Supabase Client Kontrolü ve Oluşturma
if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Hata: Supabase URL veya Service Role Key ortam değişkenleri ayarlanmamış!");
    process.exit(1); // Eksik konfigürasyonla başlatma
}
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        // Service Role Key kullandığımız için otomatik kullanıcı oturumu yönetimini devre dışı bırakabiliriz
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
    }
});
console.log("Supabase Admin Client başarıyla oluşturuldu.");

// Express Uygulaması
const app = express();

// Middleware Ayarları
app.use(cors({
    // Geliştirme ortamınızın veya canlı CRM uygulamanızın URL'sini buraya ekleyin
    // origin: 'https://sizin-crm-uygulamanizin-adresi.com', // Örnek: Canlı için
    origin: '*', // Veya geliştirme sırasında tümüne izin ver (canlıda kısıtla!)
    methods: ['POST', 'GET', 'OPTIONS'], // İzin verilen metodlar
    allowedHeaders: ['Content-Type', 'Authorization'], // İzin verilen başlıklar
}));
app.use(express.json({ limit: '15mb' })); // Body boyut limitini biraz daha artırdık (HTML + CSS)
app.use(express.urlencoded({ extended: true })); // URL-encoded veriyi işlemek için (gerekirse)

// Basit Root Endpoint (Sağlık kontrolü veya bilgi için)
app.get('/', (req, res) => {
    res.status(200).send('CeraCRM PDF Generation Service is running!');
});

// Ana PDF Oluşturma Endpoint'i
app.post('/api/generate-pdf', async (req, res) => {
    console.log("PDF oluşturma isteği alındı (/api/generate-pdf).");
    let browser = null; // Tarayıcı örneğini dışarıda tanımla ki finally bloğunda kapatılabilsin

    // İstek Body'sinden verileri al (Destructuring)
    const {
        htmlContent,    // CSS gömülü HTML içeriği
        customerId,     // Müşteri ID'si (dosya yolu için)
        contractId,     // Sözleşme ID'si (loglama veya geçici dosya adı için)
        fileName: requestedFileName, // Frontend'de oluşturulan temiz dosya adı
        headerData      // Header/Footer'da kullanılacak dinamik veri objesi
    } = req.body;

    // --- Gelen Veri Doğrulaması ---
    if (!htmlContent) {
        console.error("Hata: İstek body'sinde 'htmlContent' eksik.");
        return res.status(400).json({ success: false, error: 'HTML içeriği (htmlContent) zorunludur.' });
    }
    if (!customerId) {
        console.error("Hata: İstek body'sinde 'customerId' eksik.");
        return res.status(400).json({ success: false, error: 'Müşteri ID (customerId) zorunludur.' });
    }
    if (!requestedFileName) {
        console.error("Hata: İstek body'sinde 'fileName' eksik.");
        return res.status(400).json({ success: false, error: 'Dosya adı (fileName) zorunludur.' });
    }
    if (!headerData) {
        console.error("Hata: İstek body'sinde 'headerData' objesi eksik.");
        return res.status(400).json({ success: false, error: 'Header verileri (headerData) zorunludur.' });
    }
    // headerData içindeki temel alanları kontrol et
    if (!headerData.customerName || !headerData.templateName || !headerData.generationDate) {
        console.error("Hata: 'headerData' içinde customerName, templateName veya generationDate eksik.");
        return res.status(400).json({ success: false, error: 'Header verileri (headerData) içinde customerName, templateName ve generationDate alanları zorunludur.' });
    }
    console.log(`İstek verileri doğrulandı. Müşteri ID: ${customerId}, Dosya Adı: ${requestedFileName}`);

    try {
        // --- Puppeteer Başlatma ---
        console.log("Puppeteer başlatılıyor...");
        // Render.com gibi ortamlarda @sparticuz/chromium'u doğru kullanmak önemli
        const executablePath = process.env.CHROME_EXECUTABLE_PATH || (await chrome.executablePath());
        console.log(`Chromium yolu: ${executablePath}`);

        browser = await puppeteer.launch({
            args: [
                ...chrome.args, // Sparticuz'un önerdiği temel argümanlar
                '--no-sandbox', // Sandbox'ı devre dışı bırak (Render gibi ortamlarda genellikle gerekli)
                '--disable-setuid-sandbox', // Setuid sandbox'ı devre dışı bırak
                '--disable-dev-shm-usage', // /dev/shm kullanımını devre dışı bırak (bellek sorunlarını önleyebilir)
                '--disable-gpu', // GPU hızlandırmayı devre dışı bırak (headless için genellikle önerilir)
                '--font-render-hinting=none', // Font render ipuçlarını devre dışı bırak (bazı font sorunlarını çözebilir)
                '--hide-scrollbars',
                '--disable-web-security', // Cross-origin sorunları için (dikkatli kullanılmalı)
            ],
            executablePath: executablePath,
            headless: chrome.headless, // Sparticuz'dan gelen headless modunu kullan (genellikle true)
            ignoreHTTPSErrors: true, // HTTPS hatalarını yoksay (gerekirse)
            dumpio: process.env.NODE_ENV !== 'production', // Geliştirme ortamında tarayıcı loglarını konsola bas
        });
        console.log("Puppeteer başarıyla başlatıldı.");

        const page = await browser.newPage();
        console.log("Yeni sayfa (tab) oluşturuldu.");

        // --- HTML İçeriğini Yükleme ---
        console.log("HTML içeriği sayfaya yükleniyor...");
        // waitUntil: 'networkidle0' - Sayfadaki ağ etkinliği durana kadar bekle (CSS, font, resim yüklemeleri için)
        // Timeout süresini gerekirse artırabilirsiniz (varsayılan 30sn)
        await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 60000 });
        console.log("HTML içeriği başarıyla yüklendi.");

        // --- Header ve Footer Şablonlarını Oluşturma ---
        // Logo için: Eğer public URL varsa doğrudan kullan, yoksa base64 data URI kullan.
        // Public URL örneği: const logoHtml = `<img src="${headerData.logoUrl}" style="height: 30px; width: auto; max-width: 100px;">`;
        // Base64 örneği: const logoHtml = `<img src="data:image/png;base64,${base64LogoData}" style="height: 30px; width: auto; max-width: 100px;">`;
        // Şimdilik URL varsayımıyla devam ediyoruz, eğer frontend'den base64 gelmiyorsa logoUrl boş olabilir.
        const logoHtml = headerData.logoUrl
            ? `<img src="${headerData.logoUrl}" style="height: 30px; width: auto; max-width: 100px; vertical-align: middle;">`
            : '<span style="display: inline-block; width: 100px;"></span>'; // Logo yoksa yer tutucu

        const headerHtml = `
<div style="box-sizing: border-box; width: 100%; font-size: 9px; padding: 10px 50px 5px 50px; /* Sol/Sağ padding PDF marjinleriyle aynı */ display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #dddddd; font-family: 'DejaVu Sans', 'Noto Sans TR', sans-serif;">
    ${logoHtml}
    <div style="text-align: right; color: #555555; line-height: 1.3;">
        <div style="font-weight: bold;">${headerData.customerName}</div>
        <div>${headerData.templateName}${headerData.projectName ? ` - ${headerData.projectName}` : ''}</div>
        <div>Oluşturma Tarihi: ${headerData.generationDate}</div>
    </div>
</div>`;

        const footerHtml = `
<div style="box-sizing: border-box; width: 100%; font-size: 8px; padding: 5px 50px 10px 50px; text-align: center; color: #777777; font-family: 'DejaVu Sans', 'Noto Sans TR', sans-serif;">
    Sayfa <span class="pageNumber"></span> / <span class="totalPages"></span>
</div>`;

        // --- PDF Oluşturma ---
        console.log("PDF buffer oluşturuluyor...");
        const pdfBuffer = await page.pdf({
            format: 'A4', // Sayfa formatı
            printBackground: true, // Arka plan renklerini ve resimlerini yazdır
            margin: { // Kenar boşlukları (header/footer için yeterli alan bırakılmalı)
                top: '70px',    // Header için alan
                right: '50px',
                bottom: '60px', // Footer için alan
                left: '50px'
            },
            displayHeaderFooter: true, // Header ve Footer'ı göster
            headerTemplate: headerHtml, // Oluşturulan header HTML'i
            footerTemplate: footerHtml, // Oluşturulan footer HTML'i
            preferCSSPageSize: true, // CSS @page kurallarını dikkate al (genellikle A4 için iyidir)
            timeout: 60000, // PDF oluşturma işlemi için timeout (ms)
        });
        console.log(`PDF buffer başarıyla oluşturuldu (Boyut: ${pdfBuffer.length} bytes).`);

        // --- Tarayıcıyı Kapatma ---
        console.log("Puppeteer tarayıcısı kapatılıyor...");
        await browser.close();
        browser = null; // Referansı temizle
        console.log("Tarayıcı başarıyla kapatıldı.");

        // --- Supabase Storage'a Yükleme ---
        // Dosya yolu: bucket_adı/contracts/musteri_id/dosya_adı.pdf
        const filePath = `contracts/${customerId}/${requestedFileName}`;
        console.log(`PDF Supabase Storage'a yükleniyor: ${storageBucketName}/${filePath}`);

        const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
            .from(storageBucketName)
            .upload(filePath, pdfBuffer, {
                contentType: 'application/pdf', // Dosya tipini belirt
                upsert: false, // Aynı isimde dosya varsa üzerine yazma (hata verir)
                // cacheControl: '3600' // İsteğe bağlı cache ayarı
            });

        if (uploadError) {
            console.error("Supabase Storage yükleme hatası:", uploadError);
            // Daha detaylı hata loglaması
            if (uploadError.message.includes('Bucket not found')) {
                 throw new Error(`Supabase Storage Hatası: '${storageBucketName}' bucket bulunamadı. Lütfen Supabase projenizde bu isimde bir bucket oluşturun veya ortam değişkenini kontrol edin.`);
            } else if (uploadError.message.includes('Duplicate')) {
                 throw new Error(`Supabase Storage Hatası: Bu isimde bir dosya zaten mevcut (${filePath}). Upsert kapalı.`);
            }
            throw new Error(`Supabase Storage Hatası: ${uploadError.message}`);
        }
        console.log("PDF Supabase Storage'a başarıyla yüklendi. Path:", uploadData?.path);

        // --- Başarılı Yanıtı Döndürme ---
        // Frontend'in veritabanına kaydetmesi için dosya yolunu (path) gönder
        res.status(200).json({ success: true, filePath: uploadData?.path });
        console.log("Başarılı yanıt (200) frontend'e gönderildi.");

    } catch (error) {
        // --- Hata Yönetimi ---
        console.error('PDF oluşturma/yükleme sürecinde kritik hata:', error);

        // Tarayıcı hala açıksa kapatmayı dene
        if (browser) {
            console.warn("Hata oluştu, açık kalan tarayıcı kapatılmaya çalışılıyor...");
            try {
                await browser.close();
                console.log("Hata sonrası açık kalan tarayıcı kapatıldı.");
            } catch (closeError) {
                console.error("Hata sonrası tarayıcıyı kapatırken ek hata oluştu:", closeError);
            }
        }

        // Hata yanıtını frontend'e gönder
        res.status(500).json({
            success: false,
            error: error.message || 'PDF oluşturulurken veya yüklenirken bilinmeyen bir sunucu hatası oluştu.'
        });
        console.log("Hata yanıtı (500) frontend'e gönderildi.");
    }
});

// --- Sunucuyu Başlatma ---
app.listen(PORT, '0.0.0.0', () => { // '0.0.0.0' tüm ağ arayüzlerini dinlemesini sağlar (Render.com için önemlidir)
    console.log(`✅ CeraCRM PDF Sunucusu ${PORT} portunda başarıyla başlatıldı ve dinlemede...`);
    console.log(`➡️  Supabase URL: ${supabaseUrl}`);
    console.log(`🪣 Supabase Bucket: ${storageBucketName}`);
});

// Uygulamanın düzgün kapanmasını sağlama (isteğe bağlı ama önerilir)
process.on('SIGTERM', () => {
  console.log('SIGTERM sinyali alındı, sunucu kapatılıyor...');
  // Gerekirse açık bağlantıları veya işlemleri burada temizle
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT sinyali alındı (Ctrl+C), sunucu kapatılıyor...');
  process.exit(0);
});