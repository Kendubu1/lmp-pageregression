const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const sql = require('mssql');
const sharp = require('sharp');
const { BlobServiceClient } = require('@azure/storage-blob');

const logFilePath = path.join(__dirname, 'test_log.txt');

// Azure Storage configuration
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'images';

if (!connectionString) {
    console.error('FATAL: AZURE_STORAGE_CONNECTION_STRING is not set.');
    process.exit(1);
}
const requiredSqlVars = ['SQL_USER', 'SQL_PASSWORD', 'SQL_DATABASE', 'SQL_SERVER'];
for (const v of requiredSqlVars) {
    if (!process.env[v]) {
        console.error(`FATAL: ${v} environment variable is not set.`);
        process.exit(1);
    }
}

const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
const containerClient = blobServiceClient.getContainerClient(containerName);

// Azure SQL Database configuration
const sqlConfig = {
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DATABASE,
    server: process.env.SQL_SERVER,
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    },
    options: {
        encrypt: true,
        trustServerCertificate: false
    }
};

function logToFile(message) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFilePath, `${timestamp} - ${message}\n`);
}

async function uploadToAzure(buffer, blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(buffer, buffer.length);
    return blockBlobClient.url;
}

async function downloadFromAzure(blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const downloadResponse = await blockBlobClient.download();
    return await streamToBuffer(downloadResponse.readableStreamBody);
}

async function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on("data", (data) => {
            chunks.push(data instanceof Buffer ? data : Buffer.from(data));
        });
        readableStream.on("end", () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on("error", reject);
    });
}

let dbPool = null;

async function getDbPool() {
    if (!dbPool || !dbPool.connected) {
        try {
            dbPool = await sql.connect(sqlConfig);
            dbPool.on('error', (err) => {
                console.error('SQL pool error in pixletest, will reconnect:', err.message);
                dbPool = null;
            });
        } catch (err) {
            dbPool = null;
            throw err;
        }
    }
    return dbPool;
}

async function saveTestResult(url, result, status, baselineImageUrl, currentImageUrl, diffImageUrl = null, diffPercentage = null) {
    try {
        const pool = await getDbPool();
        const testDate = new Date().toISOString();
        const request = pool.request();
        const query = `
            INSERT INTO visual_tests (test_date, url, result, status, baseline_image_path, current_image_path, image_path, diff_percentage)
            VALUES (@testDate, @url, @result, @status, @baselineImageUrl, @currentImageUrl, @diffImageUrl, @diffPercentage)
        `;
        request.input('testDate', sql.DateTime, testDate);
        request.input('url', sql.NVarChar, url);
        request.input('result', sql.NVarChar, result);
        request.input('status', sql.NVarChar, status);
        request.input('baselineImageUrl', sql.NVarChar, baselineImageUrl);
        request.input('currentImageUrl', sql.NVarChar, currentImageUrl);
        request.input('diffImageUrl', sql.NVarChar, diffImageUrl);
        request.input('diffPercentage', sql.Float, diffPercentage);

        const queryResult = await request.query(query);
        console.log(`Test result saved: ${testDate}, ${url}, ${result}, ${status}`);
        console.log(`Rows affected: ${queryResult.rowsAffected}`);
    } catch (err) {
        console.error('Error saving test result:', err);
    }
}

async function compareImages(baselineImageBuffer, currentImageBuffer) {
    try {
        console.log('Resizing images if necessary...');
        const baselineMetadata = await sharp(baselineImageBuffer).metadata();
        const currentMetadata = await sharp(currentImageBuffer).metadata();

        let resizedBaselineImage = baselineImageBuffer;
        let resizedCurrentImage = currentImageBuffer;

        // Resize images to match the largest dimensions
        const maxWidth = Math.max(baselineMetadata.width, currentMetadata.width);
        const maxHeight = Math.max(baselineMetadata.height, currentMetadata.height);

        if (baselineMetadata.width !== maxWidth || baselineMetadata.height !== maxHeight) {
            resizedBaselineImage = await sharp(baselineImageBuffer)
                .resize(maxWidth, maxHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                .png()
                .toBuffer();
        }

        if (currentMetadata.width !== maxWidth || currentMetadata.height !== maxHeight) {
            resizedCurrentImage = await sharp(currentImageBuffer)
                .resize(maxWidth, maxHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                .png()
                .toBuffer();
        }

        console.log('Converting images to PNG format...');
        const baseline = PNG.sync.read(resizedBaselineImage);
        const current = PNG.sync.read(resizedCurrentImage);

        const { width, height } = baseline;
        const diff = new PNG({ width, height });

        console.log('Calculating pixel differences...');
        const diffPixels = pixelmatch(baseline.data, current.data, diff.data, width, height, {
            threshold: 0.1,
            includeAA: true,
            diffColor: [255, 0, 0],  // Red color for differences
            alpha: 0.7,
        });

        const diffPercentage = (diffPixels / (width * height)) * 100;

        let diffBuffer;
        if (diffPercentage > 0) {
            console.log('Creating diff image...');
            // Create a red highlight for differences
            const redHighlight = Buffer.alloc(width * height * 4);
            for (let i = 0; i < diff.data.length; i += 4) {
                if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
                    redHighlight[i] = 255;     // R
                    redHighlight[i + 1] = 0;   // G
                    redHighlight[i + 2] = 0;   // B
                    redHighlight[i + 3] = 128; // A (semi-transparent)
                }
            }

            diffBuffer = await sharp(resizedCurrentImage)
                .composite([{
                    input: redHighlight,
                    raw: {
                        width,
                        height,
                        channels: 4
                    },
                    blend: 'over'
                }])
                .png()
                .toBuffer();
        } else {
            console.log('No differences found, using current image as diff image...');
            diffBuffer = currentImageBuffer;
        }

        console.log('Image comparison completed.');
        return { diffPixels, diffPercentage, diffBuffer };
    } catch (error) {
        console.error('Error in compareImages:', error);
        throw error;
    }
}

async function runVisualTest(browser, config) {
    let successCount = 0;
    let failCount = 0;
    for (const locale of config.locales) {
        const fullUrl = config.baseUrl.replace('{locale}', locale);
        const urlSlug = fullUrl.replace(/[^a-zA-Z0-9]/g, '_');
        const currentDate = new Date().toISOString().split('T')[0]; // Get current date in YYYY-MM-DD format
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const baselineImageName = `baseline_images/${urlSlug}_${currentDate}_baseline.png`;
        const currentImageName = `current_images/${urlSlug}_${timestamp}_current.png`;
        const diffImageName = `diff_images/${urlSlug}_${timestamp}_diff.png`;

        const page = await browser.newPage();
        await page.setViewportSize({ width: 1920, height: 1080 });

        try {
            await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(3000);  // Wait for any final animations or content to settle

            // Search for and pause carousels
            const carouselButtons = await page.$$('button.carousel-control-autoplay');
            for (const button of carouselButtons) {
                const isPlaying = await button.getAttribute('aria-pressed') === 'false';
                if (isPlaying) {
                    await button.click();
                    console.log('Paused a carousel');
                }
            }

            await autoScroll(page);
            await page.waitForTimeout(2000);  // Wait for any final animations or content to settle

            const screenshot = await page.screenshot({ fullPage: true });

            let baselineExists = true;
            try {
                await downloadFromAzure(baselineImageName);
            } catch (error) {
                if (error.statusCode === 404) {
                    baselineExists = false;
                } else {
                    throw error;
                }
            }

            if (!baselineExists) {
                const baselineImageUrl = await uploadToAzure(screenshot, baselineImageName);
                const currentImageUrl = await uploadToAzure(screenshot, currentImageName);
                await saveTestResult(fullUrl, "Null", "Baseline image created.", baselineImageUrl, currentImageUrl);
                logToFile("Baseline image created for: " + fullUrl);
                console.log("Baseline image created.");
                continue;
            }

            const baselineImageBuffer = await downloadFromAzure(baselineImageName);
            const currentImageBuffer = screenshot;

            const { diffPixels, diffPercentage, diffBuffer } = await compareImages(baselineImageBuffer, currentImageBuffer);

            console.log(`Difference for ${fullUrl}: ${diffPercentage.toFixed(2)}%`);

            const currentImageUrl = await uploadToAzure(currentImageBuffer, currentImageName);
            const diffImageUrl = await uploadToAzure(diffBuffer, diffImageName);

            if (diffPercentage > 15) {  // Allow 15% difference
                await saveTestResult(fullUrl, "Fail", `Detected ${diffPixels} pixel differences (${diffPercentage.toFixed(2)}%).`, baselineImageName, currentImageUrl, diffImageUrl, diffPercentage);
                logToFile(`Detected significant differences for ${fullUrl}: ${diffPercentage.toFixed(2)}% different`);
            } else {
                await saveTestResult(fullUrl, "Pass", `Acceptable differences: ${diffPercentage.toFixed(2)}% different.`, baselineImageName, currentImageUrl, diffImageUrl, diffPercentage);
                logToFile(`No significant differences for ${fullUrl}: ${diffPercentage.toFixed(2)}% different`);
            }

            // Update baseline with current image if it's a new day
            const baselineLastModified = await containerClient.getBlockBlobClient(baselineImageName).getProperties();
            if (baselineLastModified.lastModified.toISOString().split('T')[0] !== currentDate) {
                await uploadToAzure(currentImageBuffer, baselineImageName);
                logToFile(`Updated baseline image for ${fullUrl}`);
                console.log(`Updated baseline image for ${fullUrl}`);
            }
            successCount++;
        } catch (error) {
            failCount++;
            await saveTestResult(fullUrl, "Error", error.message, baselineImageName, currentImageName);
            logToFile(`Error processing ${fullUrl}: ${error.message}`);
        } finally {
            await page.close();
        }
    }
    return { successCount, failCount };
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

async function main() {
    // Parse the command line argument (supports JSON string, file path, or fallback to config.json)
    let testConfig;
    if (process.argv[2]) {
        const arg = process.argv[2];
        try {
            // Try as a file path first (used by server.js temp config files)
            if (fs.existsSync(arg)) {
                const fileContent = fs.readFileSync(arg, 'utf8');
                testConfig = JSON.parse(fileContent);
                console.log(`Loaded config from file: ${arg}`);
            } else {
                // Fall back to parsing as inline JSON
                testConfig = JSON.parse(arg);
                console.log('Parsed config from command line argument');
            }
        } catch (error) {
            console.error('Error parsing test config:', error);
            process.exit(1);
        }
    } else {
        testConfig = require('./config.json');
        console.log('Loaded config from config.json');
    }
    
    const browser = await chromium.launch({
        headless: true,  // Set to true for production runs
        args: ['--window-size=1920,1080'],
        slowMo: 50
    });

    try {
        const { successCount, failCount } = await runVisualTest(browser, testConfig.tests[0]);
        console.log(`Test results: ${successCount} succeeded, ${failCount} failed`);
        if (successCount === 0 && failCount > 0) {
            throw new Error(`All ${failCount} locale tests failed — no screenshots generated`);
        }
    } finally {
        await browser.close();
        if (dbPool) {
            try { await dbPool.close(); } catch (e) { /* ignore */ }
        }
    }
}

main()
    .then(() => {
        console.log('Visual test run completed successfully.');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Visual test run failed:', error);
        process.exit(1);
    });
