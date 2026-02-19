require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { execFile } = require('child_process');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Local storage paths
const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(__dirname, 'images');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');

// Ensure directories exist
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

ensureDir(DATA_DIR);
ensureDir(IMAGES_DIR);
ensureDir(path.join(IMAGES_DIR, 'baseline_images'));
ensureDir(path.join(IMAGES_DIR, 'current_images'));
ensureDir(path.join(IMAGES_DIR, 'diff_images'));

// --- Local JSON file helpers ---

function readJSON(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return [];
    }
}

function writeJSON(filePath, data) {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
}

function getNextId(items) {
    if (items.length === 0) return 1;
    return Math.max(...items.map(i => i.id)) + 1;
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static(__dirname));
app.use(bodyParser.json());

// Store cron tasks in memory
let cronTasks = {};

// --- API Endpoints ---

// Fetch test results
app.get('/api/test-results', (req, res) => {
    console.log('Fetching test results');
    try {
        const results = readJSON(RESULTS_FILE);
        // Sort by test_date descending
        results.sort((a, b) => new Date(b.test_date) - new Date(a.test_date));
        console.log(`Fetched ${results.length} test results`);
        res.json(results);
    } catch (err) {
        console.error('Error reading test results:', err);
        res.status(500).json({ error: 'An error occurred while fetching test results' });
    }
});

// Serve images from local filesystem
app.get('/images/:imagePath(*)', (req, res) => {
    const imagePath = req.params.imagePath;
    const filePath = path.join(IMAGES_DIR, imagePath);
    console.log(`Attempting to serve image: ${imagePath}`);

    if (!fs.existsSync(filePath)) {
        console.log(`Image not found: ${imagePath}`);
        return res.status(404).send('Image not found');
    }

    res.setHeader('Content-Type', 'image/png');
    fs.createReadStream(filePath).pipe(res);
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Pause a schedule
app.post('/api/pause-schedule/:id', (req, res) => {
    const id = parseInt(req.params.id);
    console.log(`Attempting to pause schedule with ID: ${id}`);
    try {
        const schedules = readJSON(SCHEDULES_FILE);
        const schedule = schedules.find(s => s.id === id);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        schedule.is_paused = true;
        writeJSON(SCHEDULES_FILE, schedules);

        if (cronTasks[id]) {
            cronTasks[id].task.stop();
            console.log(`Schedule paused in memory for ID: ${id}`);
        }
        res.json({ message: 'Schedule paused successfully' });
    } catch (err) {
        console.error('Error pausing schedule:', err);
        res.status(500).json({ error: 'Failed to pause schedule' });
    }
});

// Resume a schedule
app.post('/api/resume-schedule/:id', (req, res) => {
    const id = parseInt(req.params.id);
    console.log(`Attempting to resume schedule with ID: ${id}`);
    try {
        const schedules = readJSON(SCHEDULES_FILE);
        const schedule = schedules.find(s => s.id === id);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        schedule.is_paused = false;
        writeJSON(SCHEDULES_FILE, schedules);

        if (cronTasks[id]) {
            cronTasks[id].task.start();
            console.log(`Schedule resumed in memory for ID: ${id}`);
        } else {
            setupSchedule(id, schedule.base_url, JSON.parse(schedule.locales), schedule.cron_expression, false);
        }
        res.json({ message: 'Schedule resumed successfully' });
    } catch (err) {
        console.error('Error resuming schedule:', err);
        res.status(500).json({ error: 'Failed to resume schedule' });
    }
});

// Update a schedule
app.put('/api/update-schedule/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { cronExpression, testConfig } = req.body;
    console.log(`Attempting to update schedule with ID: ${id}`);

    if (!cron.validate(cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression' });
    }

    try {
        const schedules = readJSON(SCHEDULES_FILE);
        const schedule = schedules.find(s => s.id === id);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }

        schedule.base_url = testConfig.baseUrl;
        schedule.locales = JSON.stringify(testConfig.locales);
        schedule.cron_expression = cronExpression;
        writeJSON(SCHEDULES_FILE, schedules);

        if (cronTasks[id]) {
            cronTasks[id].task.stop();
        }
        setupSchedule(id, testConfig.baseUrl, testConfig.locales, cronExpression, false);
        res.json({ message: 'Schedule updated successfully' });
    } catch (err) {
        console.error('Error updating schedule:', err);
        res.status(500).json({ error: 'Failed to update schedule' });
    }
});

// Create a new schedule
app.post('/api/set-schedule', (req, res) => {
    const { cronExpression, testConfig } = req.body;
    console.log(`Setting schedule for ${testConfig.baseUrl} with cron: ${cronExpression}`);

    if (!cron.validate(cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression' });
    }

    try {
        const schedules = readJSON(SCHEDULES_FILE);
        const newSchedule = {
            id: getNextId(schedules),
            base_url: testConfig.baseUrl,
            locales: JSON.stringify(testConfig.locales),
            cron_expression: cronExpression,
            run_count: 0,
            created_at: new Date().toISOString(),
            last_run: null,
            is_paused: false
        };
        schedules.push(newSchedule);
        writeJSON(SCHEDULES_FILE, schedules);

        console.log(`Schedule saved for ${testConfig.baseUrl} with ID: ${newSchedule.id}`);
        setupSchedule(newSchedule.id, testConfig.baseUrl, testConfig.locales, cronExpression);
        res.json({ message: 'Schedule set successfully', id: newSchedule.id });
    } catch (err) {
        console.error('Error saving schedule:', err);
        res.status(500).json({ error: 'Failed to save schedule' });
    }
});

// Get all schedules
app.get('/api/schedules', (req, res) => {
    console.log('Fetching schedules');
    try {
        const schedules = readJSON(SCHEDULES_FILE);
        console.log(`Fetched ${schedules.length} schedules`);
        const currentSchedules = schedules.map(row => ({
            id: row.id,
            baseUrl: row.base_url,
            locales: JSON.parse(row.locales),
            cronExpression: row.cron_expression,
            runCount: row.run_count,
            createdAt: row.created_at,
            lastRun: row.last_run,
            is_paused: row.is_paused,
            active: !!cronTasks[row.id]
        }));
        res.json(currentSchedules);
    } catch (err) {
        console.error('Error fetching schedules:', err);
        res.status(500).json({ error: 'Failed to fetch schedules' });
    }
});

// Delete a schedule
app.delete('/api/schedule/:id', (req, res) => {
    const id = parseInt(req.params.id);
    console.log(`Attempting to delete schedule with ID: ${id}`);
    try {
        let schedules = readJSON(SCHEDULES_FILE);
        const index = schedules.findIndex(s => s.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Schedule not found' });
        }

        schedules.splice(index, 1);
        writeJSON(SCHEDULES_FILE, schedules);

        if (cronTasks[id]) {
            cronTasks[id].task.stop();
            delete cronTasks[id];
            console.log(`Schedule deleted from memory for ID: ${id}`);
        }
        res.json({ message: 'Schedule deleted successfully' });
    } catch (err) {
        console.error('Error deleting schedule:', err);
        res.status(500).json({ error: 'Failed to delete schedule' });
    }
});

// Run a test immediately
app.post('/api/run-test', (req, res) => {
    const { baseUrl } = req.body;
    console.log(`Manually running test for ${baseUrl}`);
    try {
        const schedules = readJSON(SCHEDULES_FILE);
        const schedule = schedules.find(s => s.base_url === baseUrl);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        const locales = JSON.parse(schedule.locales);
        runScheduledTest(baseUrl, locales);
        res.json({ message: 'Test started' });
    } catch (err) {
        console.error('Error starting manual test:', err);
        res.status(500).json({ error: 'Failed to start test' });
    }
});

function runScheduledTest(baseUrl, locales) {
    console.log(`Running Playwright test for ${baseUrl} with locales: ${locales}`);
    try {
        // Update run_count and last_run in schedules file
        const schedules = readJSON(SCHEDULES_FILE);
        const schedule = schedules.find(s => s.base_url === baseUrl);
        if (schedule) {
            schedule.run_count = (schedule.run_count || 0) + 1;
            schedule.last_run = new Date().toISOString();
            writeJSON(SCHEDULES_FILE, schedules);
        }

        const testConfig = JSON.stringify({
            tests: [{ baseUrl, locales }]
        });
        console.log(`Executing Playwright script with config: ${testConfig}`);

        const scriptPath = path.join(__dirname, 'pixletest.js');

        return new Promise((resolve, reject) => {
            execFile(process.execPath, [scriptPath, testConfig], (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error executing Playwright script: ${error.message}`);
                    reject(error);
                    return;
                }
                console.log(`Playwright script output: ${stdout}`);
                if (stderr) {
                    console.error(`Playwright script errors: ${stderr}`);
                }
                resolve(stdout);
            });
        });
    } catch (err) {
        console.error('Error running scheduled test:', err);
        throw err;
    }
}

function setupSchedule(id, baseUrl, locales, cronExpression, isPaused) {
    console.log(`Setting up schedule: ID=${id}, BaseURL=${baseUrl}, Cron=${cronExpression}, Paused=${isPaused}`);

    if (typeof cronExpression !== 'string' || cronExpression.trim() === '') {
        console.error(`Cannot set up schedule: Invalid cron expression for ID ${id}: "${cronExpression}"`);
        return;
    }

    try {
        const task = cron.schedule(cronExpression, async () => {
            console.log(`Cron job triggered for ${baseUrl} at ${new Date().toISOString()}`);
            try {
                await runScheduledTest(baseUrl, locales);
                console.log(`Scheduled test completed for ${baseUrl}`);
            } catch (error) {
                console.error(`Error in scheduled test for ${baseUrl}:`, error);
            }
        }, {
            scheduled: !isPaused
        });

        cronTasks[id] = {
            task,
            cronExpression,
            baseUrl,
            locales,
        };

        console.log(`Schedule set up successfully for ID ${id}`);
    } catch (error) {
        console.error(`Error setting up schedule for ID ${id}:`, error);
    }
}

function loadSchedulesFromFile() {
    console.log('Loading schedules from file');
    try {
        const schedules = readJSON(SCHEDULES_FILE);
        console.log(`Found ${schedules.length} schedules`);
        for (const row of schedules) {
            const locales = JSON.parse(row.locales);

            if (typeof row.cron_expression !== 'string' || row.cron_expression.trim() === '') {
                console.error(`Invalid cron expression for schedule ID ${row.id}: "${row.cron_expression}"`);
                continue;
            }

            setupSchedule(row.id, row.base_url, locales, row.cron_expression, row.is_paused);
        }
        console.log('Schedules loaded and set up');
    } catch (err) {
        console.error('Error loading schedules:', err);
    }
}

// Visualization data
app.get('/api/visualization-data', (req, res) => {
    const days = parseInt(req.query.days) || 7;
    try {
        const results = readJSON(RESULTS_FILE);
        const schedules = readJSON(SCHEDULES_FILE);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const recentResults = results.filter(r => new Date(r.test_date) >= cutoff);

        const visualizationData = {};

        for (const schedule of schedules) {
            const scheduleResults = recentResults.filter(r =>
                r.url && schedule.base_url && r.url.startsWith(schedule.base_url.replace('{locale}', '').split('{')[0])
            );

            if (scheduleResults.length === 0) continue;

            // Group by date
            const byDate = {};
            for (const r of scheduleResults) {
                const date = r.test_date.split('T')[0];
                if (!byDate[date]) byDate[date] = [];
                byDate[date].push(r);
            }

            const dates = Object.keys(byDate).sort();
            const passRates = [];
            const avgDiffPercentages = [];

            for (const date of dates) {
                const dayResults = byDate[date];
                const total = dayResults.length;
                const passed = dayResults.filter(r => r.result === 'Pass').length;
                const passRate = (passed / total) * 100;
                const avgDiff = dayResults.reduce((sum, r) => sum + (r.diff_percentage || 0), 0) / total;
                passRates.push(parseFloat(passRate.toFixed(2)));
                avgDiffPercentages.push(parseFloat(avgDiff.toFixed(2)));
            }

            visualizationData[schedule.id] = {
                baseUrl: schedule.base_url,
                dates,
                passRates,
                avgDiffPercentages
            };
        }

        res.json(visualizationData);
    } catch (err) {
        console.error('Error fetching visualization data:', err);
        res.status(500).json({ error: 'Failed to fetch visualization data' });
    }
});

// Start the server
loadSchedulesFromFile();
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
