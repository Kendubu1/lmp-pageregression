require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const sharp = require('sharp');

const logFilePath = path.join(__dirname, 'test_log.txt');

// Local storage directories
const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(__dirname, 'images');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

// Ensure directories exist
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

ensureDir(DATA_DIR);
ensureDir(path.join(IMAGES_DIR, 'baseline_images'));
ensureDir(path.join(IMAGES_DIR, 'current_images'));
ensureDir(path.join(IMAGES_DIR, 'diff_images'));

function logToFile(message) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFilePath, `${timestamp} - ${message}\n`);
}

function saveImageLocally(buffer, imageName) {
    const filePath = path.join(IMAGES_DIR, imageName);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, buffer);
    return imageName;
}

function loadImageLocally(imageName) {
    const filePath = path.join(IMAGES_DIR, imageName);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return fs.readFileSync(filePath);
}

function getImageModifiedDate(imageName) {
    const filePath = path.join(IMAGES_DIR, imageName);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const stats = fs.statSync(filePath);
    return stats.mtime;
}

function readJSONSafe(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
        console.error(`Warning: ${filePath} was corrupted, starting fresh. Error: ${err.message}`);
        return [];
    }
}

function writeJSONAtomic(filePath, data) {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
}

function saveTestResult(url, result, status, baselineImagePath, currentImagePath, diffImagePath = null, diffPercentage = null) {
    try {
        const results = readJSONSafe(RESULTS_FILE);

        const nextId = results.length > 0 ? Math.max(...results.map(r => r.id)) + 1 : 1;
        const testResult = {
            id: nextId,
            test_date: new Date().toISOString(),
            url,
            result,
            status,
            baseline_image_path: baselineImagePath,
            current_image_path: currentImagePath,
            image_path: diffImagePath,
            diff_percentage: diffPercentage
        };

        results.push(testResult);
        writeJSONAtomic(RESULTS_FILE, results);
        console.log(`Test result saved: ${testResult.test_date}, ${url}, ${result}, ${status}, diff: ${diffPercentage}`);
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

            // Check if baseline exists locally
            const existingBaseline = loadImageLocally(baselineImageName);

            if (!existingBaseline) {
                saveImageLocally(screenshot, baselineImageName);
                saveImageLocally(screenshot, currentImageName);
                saveTestResult(fullUrl, "Null", "Baseline image created.", baselineImageName, currentImageName);
                logToFile("Baseline image created for: " + fullUrl);
                console.log("Baseline image created.");
                continue;
            }

            const baselineImageBuffer = existingBaseline;
            const currentImageBuffer = screenshot;

            const { diffPixels, diffPercentage, diffBuffer } = await compareImages(baselineImageBuffer, currentImageBuffer);

            console.log(`Difference for ${fullUrl}: ${diffPercentage.toFixed(2)}%`);

            const currentImagePath = saveImageLocally(currentImageBuffer, currentImageName);
            const diffImagePath = saveImageLocally(diffBuffer, diffImageName);

            if (diffPercentage > 15) {  // Allow 15% difference
                saveTestResult(fullUrl, "Fail", `Detected ${diffPixels} pixel differences (${diffPercentage.toFixed(2)}%).`, baselineImageName, currentImagePath, diffImagePath, diffPercentage);
                logToFile(`Detected significant differences for ${fullUrl}: ${diffPercentage.toFixed(2)}% different`);
            } else {
                saveTestResult(fullUrl, "Pass", `Acceptable differences: ${diffPercentage.toFixed(2)}% different.`, baselineImageName, currentImagePath, diffImagePath, diffPercentage);
                logToFile(`No significant differences for ${fullUrl}: ${diffPercentage.toFixed(2)}% different`);
            }

            // Update baseline with current image if it's a new day
            const baselineModified = getImageModifiedDate(baselineImageName);
            if (baselineModified && baselineModified.toISOString().split('T')[0] !== currentDate) {
                saveImageLocally(currentImageBuffer, baselineImageName);
                logToFile(`Updated baseline image for ${fullUrl}`);
                console.log(`Updated baseline image for ${fullUrl}`);
            }
        } catch (error) {
            saveTestResult(fullUrl, "Error", error.message, baselineImageName, currentImageName);
            logToFile(`Error processing ${fullUrl}: ${error.message}`);
        } finally {
            await page.close();
        }
    }
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
    // Parse the command line argument
    let testConfig;
    if (process.argv[2]) {
        try {
            testConfig = JSON.parse(process.argv[2]);
        } catch (error) {
            console.error('Error parsing JSON from command line argument:', error);
            process.exit(1);
        }
    } else if (fs.existsSync(path.join(__dirname, 'config.json'))) {
        testConfig = require('./config.json');
    } else {
        console.error('No test config provided. Pass JSON as argument or create config.json');
        process.exit(1);
    }

    const browser = await chromium.launch({
        headless: true,
        args: ['--window-size=1920,1080'],
        slowMo: 50
    });

    await runVisualTest(browser, testConfig.tests[0]);
    await browser.close();
}

main().catch(console.error);
