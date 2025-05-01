// server.js
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chrome = require('@sparticuz/chromium'); // Sparticuz versiyonunu kullanıyoruz
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3001; // Render portu kendi ayarlar

// Supabase Client (Ortam değişkenlerinden alınacak)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Gizli tut!
if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Supabase URL veya Service Key ortam değişkenleri eksik!");
    // process.exit(1); // Başlamadan çıkmak daha iyi olabilir
}
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Middleware
app.use(cors()); // Tüm kaynaklardan gelen isteklere izin ver (geliştirme için, canlıda kısıtlanabilir)
app.use(express.json({ limit: '10mb' })); // Büyük HTML içerikleri için limiti artır

// Ana PDF Oluşturma Endpoint'i
app.post('/api/generate-pdf', async (req, res) => {
    console.log("Received request to /api/generate-pdf");
    let browser = null;
    const { htmlContent, customerId, contractId, fileName: requestedFileName } = req.body; // Frontend'den gelen veriler

    // Basit doğrulama
    if (!htmlContent || !customerId || !contractId || !requestedFileName) {
        console.error("Missing data in request body");
        return res.status(400).json({ success: false, error: 'Eksik veri: htmlContent, customerId, contractId, fileName gerekli.' });
    }

    try {
        // Puppeteer'ı başlat
        console.log("Launching Puppeteer...");
        browser = await puppeteer.launch({
            args: [...chrome.args, '--hide-scrollbars', '--disable-web-security'], // Gerekli argümanlar
            executablePath: await chrome.executablePath(),
            headless: chrome.headless,
            ignoreHTTPSErrors: true,
        });
        console.log("Puppeteer launched.");

        const page = await browser.newPage();

        // HTML içeriğini yükle
        console.log("Setting HTML content...");
        // waitUntil: 'networkidle0' önemlidir, tüm kaynakların (resimler vs.) yüklenmesini bekler
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        console.log("HTML content set.");

        // PDF oluştur
        console.log("Generating PDF buffer...");
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '40px', right: '50px', bottom: '60px', left: '50px' }, // Kenar boşluklarını ayarla
            // displayHeaderFooter: true, // Header/Footer HTML içinde varsa veya template ile ekleniyorsa
            // headerTemplate: '<div></div>', // Gerekirse boş header/footer
            // footerTemplate: `<div style="font-size: 8px; width: 100%; text-align: center; padding: 5px;">Sayfa <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
        });
        console.log(`PDF buffer generated (size: ${pdfBuffer.length} bytes).`);

        // Tarayıcıyı kapat (kaynakları serbest bırak)
        await browser.close();
        browser = null;
        console.log("Browser closed.");

        // Supabase Storage'a yükle
        const filePath = `contracts/${customerId}/${requestedFileName}`; // Frontend'den gelen temizlenmiş dosya adını kullan
        const storageBucketName = 'generated-contracts'; // Bucket adını kontrol et

        console.log(`Uploading PDF to Supabase Storage: ${storageBucketName}/${filePath}`);
        const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
            .from(storageBucketName)
            .upload(filePath, pdfBuffer, {
                contentType: 'application/pdf',
                upsert: false, // Üzerine yazma
            });

        if (uploadError) {
            throw new Error(`Supabase Storage Error: ${uploadError.message}`);
        }
        console.log("PDF uploaded successfully:", uploadData?.path);

        // Başarılı yanıtı döndür (dosya yolu ile birlikte)
        res.status(200).json({ success: true, filePath: uploadData?.path });

    } catch (error) {
        console.error('Error during PDF generation/upload:', error);
        if (browser) {
            try { await browser.close(); } catch (e) { console.error("Error closing browser on failure:", e); }
        }
        res.status(500).json({ success: false, error: error.message || 'Bilinmeyen bir sunucu hatası oluştu.' });
    }
});

// Sunucuyu başlat
app.listen(port, () => {
    console.log(`PDF Sunucusu ${port} portunda çalışıyor...`);
});