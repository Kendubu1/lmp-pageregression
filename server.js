const express = require('express');
const cors = require('cors');
const path = require('path');
const sql = require('mssql');
const { BlobServiceClient } = require('@azure/storage-blob');
const cron = require('node-cron');
const { exec } = require('child_process');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Azure Storage configuration
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'images';

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

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static(__dirname));
app.use(bodyParser.json());

// Store schedules in memory
let schedules = {};

// Database connection utility functions
async function connectToDatabase() {
    if (sql.connected) {
        return;
    }

    try {
        console.log('Connecting to SQL Database...');
        await sql.connect(sqlConfig);
        console.log('Connected to SQL Database.');
    } catch (err) {
        console.error('Error connecting to SQL Database:', err);
        throw err;
    }
}

async function closeDatabaseConnection() {
    if (sql.connected) {
        await sql.close();
        console.log('SQL connection closed.');
    }
}

// Fetch test results
app.get('/api/test-results', async (req, res) => {
    console.log('Fetching test results');
    try {
        await connectToDatabase();
        const result = await sql.query`SELECT * FROM visual_tests ORDER BY test_date DESC`;
        console.log(`Fetched ${result.recordset.length} test results`);
        const processedRows = result.recordset.map(row => ({
            ...row,
            baseline_image_path: extractImagePath(row.baseline_image_path),
            current_image_path: extractImagePath(row.current_image_path),
            image_path: extractImagePath(row.image_path)
        }));
        res.json(processedRows);
    } catch (err) {
        console.error('Error querying database:', err);
        res.status(500).json({ error: 'An error occurred while fetching test results' });
    } finally {
        await closeDatabaseConnection();
    }
});

function extractImagePath(fullPath) {
    if (!fullPath) return null;
    const match = fullPath.match(/\/images\/(.+)/);
    return match ? match[1] : fullPath;
}

// Serve images
app.get('/images/:imagePath(*)', async (req, res) => {
    const imagePath = req.params.imagePath;
    console.log(`Attempting to serve image: ${imagePath}`);
    try {
        const blobClient = containerClient.getBlobClient(imagePath);
        const exists = await blobClient.exists();
        if (!exists) {
            console.log(`Image not found: ${imagePath}`);
            return res.status(404).send('Image not found');
        }
        const downloadBlockBlobResponse = await blobClient.download();
        res.setHeader('Content-Type', 'image/png');
        downloadBlockBlobResponse.readableStreamBody.pipe(res);
    } catch (error) {
        console.error('Error retrieving image:', error);
        res.status(500).send('Error retrieving image');
    }
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Pause a schedule
app.post('/api/pause-schedule/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  console.log(`Attempting to pause schedule with ID: ${id}`);
  try {
    await connectToDatabase();
    const result = await sql.query`
      UPDATE schedules
      SET is_paused = 1
      WHERE id = ${id}
    `;
    if (result.rowsAffected[0] > 0) {
      if (schedules[id]) {
        schedules[id].task.stop();
        console.log(`Schedule paused in memory for ID: ${id}`);
      }
      res.json({ message: 'Schedule paused successfully' });
    } else {
      res.status(404).json({ error: 'Schedule not found' });
    }
  } catch (err) {
    console.error('Error pausing schedule:', err);
    res.status(500).json({ error: 'Failed to pause schedule' });
  } finally {
    await closeDatabaseConnection();
  }
});
  
  // Resume a schedule
  app.post('/api/resume-schedule/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    console.log(`Attempting to resume schedule with ID: ${id}`);
    try {
      await connectToDatabase();
      const result = await sql.query`
        UPDATE schedules
        SET is_paused = 0
        WHERE id = ${id}
      `;
      if (result.rowsAffected[0] > 0) {
        if (schedules[id]) {
          schedules[id].task.start();
          console.log(`Schedule resumed in memory for ID: ${id}`);
        } else {
          const scheduleResult = await sql.query`SELECT base_url, locales, cron_expression FROM schedules WHERE id = ${id}`;
          if (scheduleResult.recordset.length > 0) {
            const { base_url, locales, cron_expression } = scheduleResult.recordset[0];
            setupSchedule(id, base_url, JSON.parse(locales), cron_expression, false);
          }
        }
        res.json({ message: 'Schedule resumed successfully' });
      } else {
        res.status(404).json({ error: 'Schedule not found' });
      }
    } catch (err) {
      console.error('Error resuming schedule:', err);
      res.status(500).json({ error: 'Failed to resume schedule' });
    } finally {
      await closeDatabaseConnection();
    }
  });
  
  // Update a schedule
  app.put('/api/update-schedule/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { cronExpression, testConfig } = req.body;
    console.log(`Attempting to update schedule with ID: ${id}`);
  
    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }
  
    try {
      await connectToDatabase();
      const result = await sql.query`
        UPDATE schedules
        SET base_url = ${testConfig.baseUrl},
            locales = ${JSON.stringify(testConfig.locales)},
            cron_expression = ${cronExpression}
        WHERE id = ${id}
      `;
      if (result.rowsAffected[0] > 0) {
        if (schedules[id]) {
          schedules[id].task.stop();
        }
        setupSchedule(id, testConfig.baseUrl, testConfig.locales, cronExpression, false);
        res.json({ message: 'Schedule updated successfully' });
      } else {
        res.status(404).json({ error: 'Schedule not found' });
      }
    } catch (err) {
      console.error('Error updating schedule:', err);
      res.status(500).json({ error: 'Failed to update schedule' });
    } finally {
      await closeDatabaseConnection();
    }
  });

// Update the set-schedule endpoint
app.post('/api/set-schedule', async (req, res) => {
  const { cronExpression, testConfig } = req.body;
  console.log(`Setting schedule for ${testConfig.baseUrl} with cron: ${cronExpression}`);

  if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
  }

  try {
      await connectToDatabase();
      const result = await sql.query`
          INSERT INTO schedules (base_url, locales, cron_expression)
          OUTPUT INSERTED.id
          VALUES (${testConfig.baseUrl}, ${JSON.stringify(testConfig.locales)}, ${cronExpression})
      `;
      const scheduleId = result.recordset[0].id;
      console.log(`Schedule saved to database for ${testConfig.baseUrl} with ID: ${scheduleId}`);
      setupSchedule(scheduleId, testConfig.baseUrl, testConfig.locales, cronExpression);
      res.json({ message: 'Schedule set successfully', id: scheduleId });
  } catch (err) {
      console.error('Error saving schedule to database:', err);
      res.status(500).json({ error: 'Failed to save schedule' });
  } finally {
      await closeDatabaseConnection();
  }
});

// Update the get schedules endpoint
app.get('/api/schedules', async (req, res) => {
  console.log('Fetching schedules');
  try {
      await connectToDatabase();
      const result = await sql.query`SELECT id, base_url, locales, cron_expression, run_count, created_at, last_run, is_paused FROM schedules`;
      console.log(`Fetched ${result.recordset.length} schedules`);
      const currentSchedules = result.recordset.map(row => ({
          id: row.id,
          baseUrl: row.base_url,
          locales: JSON.parse(row.locales),
          cronExpression: row.cron_expression,
          runCount: row.run_count,
          createdAt: row.created_at,
          lastRun: row.last_run,
          is_paused: row.is_paused,
          active: !!schedules[row.id]
      }));
      res.json(currentSchedules);
  } catch (err) {
      console.error('Error fetching schedules:', err);
      res.status(500).json({ error: 'Failed to fetch schedules' });
  } finally {
      await closeDatabaseConnection();
  }
});

// Update the delete schedule endpoint
app.delete('/api/schedule/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  console.log(`Attempting to delete schedule with ID: ${id}`);
  try {
      await connectToDatabase();
      const result = await sql.query`
          DELETE FROM schedules
          WHERE id = ${id}
      `;
      console.log(`Rows affected: ${result.rowsAffected[0]}`);
      if (result.rowsAffected[0] > 0) {
          if (schedules[id]) {
              schedules[id].task.stop();
              delete schedules[id];
              console.log(`Schedule deleted from memory for ID: ${id}`);
          }
          res.json({ message: 'Schedule deleted successfully' });
      } else {
          res.status(404).json({ error: 'Schedule not found' });
      }
  } catch (err) {
      console.error('Error deleting schedule from database:', err);
      res.status(500).json({ error: 'Failed to delete schedule' });
  } finally {
      await closeDatabaseConnection();
  }
});


// Run a test immediately
app.post('/api/run-test', async (req, res) => {
    const { baseUrl } = req.body;
    console.log(`Manually running test for ${baseUrl}`);
    try {
        await connectToDatabase();
        const result = await sql.query`SELECT locales FROM schedules WHERE base_url = ${baseUrl}`;
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        const locales = JSON.parse(result.recordset[0].locales);
        runScheduledTest(baseUrl, locales);
        res.json({ message: 'Test started' });
    } catch (err) {
        console.error('Error starting manual test:', err);
        res.status(500).json({ error: 'Failed to start test' });
    } finally {
        await closeDatabaseConnection();
    }
});

async function runScheduledTest(baseUrl, locales) {
    console.log(`Running Playwright test for ${baseUrl} with locales: ${locales}`);
    try {
        await connectToDatabase();

        const updateResult = await sql.query`
            UPDATE schedules 
            SET run_count = run_count + 1, last_run = GETDATE() 
            WHERE base_url = ${baseUrl}
        `;
        console.log(`Schedule updated for ${baseUrl}. Rows affected: ${updateResult.rowsAffected}`);

        const testConfig = JSON.stringify({
            tests: [
                {
                    baseUrl,
                    locales
                }
            ]
        });
        console.log(`Executing Playwright script with config: ${testConfig}`);
        
        const scriptPath = path.join(__dirname, 'pixletest.js');
        
        return new Promise((resolve, reject) => {
            exec(`node "${scriptPath}" '${testConfig}'`, (error, stdout, stderr) => {
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
        console.error('Error running scheduled test or updating schedule:', err);
        throw err;
    } finally {
        await closeDatabaseConnection();
    }
}

// Update the setupSchedule function
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
    
    schedules[id] = {
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


async function loadSchedulesFromDatabase() {
  console.log('Loading schedules from database');
  try {
      await connectToDatabase();
      const result = await sql.query`SELECT id, base_url, locales, cron_expression, is_paused FROM schedules`;
      console.log(`Found ${result.recordset.length} schedules in database`);
      for (const row of result.recordset) {
          const id = row.id;
          const baseUrl = row.base_url;
          const locales = JSON.parse(row.locales);
          const cronExpression = row.cron_expression;
          const isPaused = row.is_paused;
          
          console.log(`Loading schedule: ID=${id}, BaseURL=${baseUrl}, Cron=${cronExpression}, Paused=${isPaused}`);
          
          if (typeof cronExpression !== 'string' || cronExpression.trim() === '') {
              console.error(`Invalid cron expression for schedule ID ${id}: "${cronExpression}"`);
              continue;  // Skip this schedule and move to the next one
          }
          
          setupSchedule(id, baseUrl, locales, cronExpression, isPaused);
      }
      console.log('Schedules loaded and set up');
  } catch (err) {
      console.error('Error loading schedules from database:', err);
  } finally {
      await closeDatabaseConnection();
  }
}

app.get('/api/visualization-data', async (req, res) => {
  const days = parseInt(req.query.days) || 7;

  try {
    await connectToDatabase();
    const result = await sql.query`
        WITH daily_results AS (
            SELECT 
                s.id AS schedule_id,
                s.base_url,
                CAST(vt.test_date AS DATE) AS date,
                COUNT(*) AS total_tests,
                SUM(CASE WHEN vt.result = 'Pass' THEN 1 ELSE 0 END) AS passed_tests,
                AVG(CAST(vt.diff_percentage AS FLOAT)) AS avg_diff_percentage
            FROM visual_tests vt
            JOIN schedules s ON vt.url LIKE s.base_url + '%'
            WHERE vt.test_date >= DATEADD(day, -${days}, GETDATE())
            GROUP BY s.id, s.base_url, CAST(vt.test_date AS DATE)
        )
        SELECT 
            schedule_id,
            base_url,
            date,
            (CAST(passed_tests AS FLOAT) / CAST(total_tests AS FLOAT)) * 100 AS pass_rate,
            avg_diff_percentage
        FROM daily_results
        ORDER BY schedule_id, date
    `;

    const visualizationData = {};

    result.recordset.forEach(row => {
      if (!visualizationData[row.schedule_id]) {
        visualizationData[row.schedule_id] = {
          baseUrl: row.base_url,
          dates: [],
          passRates: [],
          avgDiffPercentages: []
        };
      }
      visualizationData[row.schedule_id].dates.push(row.date.toISOString().split('T')[0]);
      visualizationData[row.schedule_id].passRates.push(parseFloat(row.pass_rate.toFixed(2)));
      visualizationData[row.schedule_id].avgDiffPercentages.push(parseFloat(row.avg_diff_percentage.toFixed(2)));
    });

    res.json(visualizationData);
  } catch (err) {
    console.error('Error fetching visualization data:', err);
    res.status(500).json({ error: 'Failed to fetch visualization data' });
  } finally {
    await closeDatabaseConnection();
  }
});

// Start the server and load schedules
loadSchedulesFromDatabase().then(() => {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
});