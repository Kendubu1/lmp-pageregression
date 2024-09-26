document.addEventListener('DOMContentLoaded', function() {
    loadSchedules();
    loadTestResults();

    document.getElementById('scheduleForm').addEventListener('submit', function(e) {
        e.preventDefault();
        setSchedule();
    });

    document.getElementById('dateRange').addEventListener('change', function() {
        updateVisualization(this.value);
    });
    
    updateVisualization(7);  // Default to last 7 days

    const saveEditButton = document.getElementById('saveEditSchedule');
    if (saveEditButton) {
        saveEditButton.addEventListener('click', saveEditSchedule);
    } else {
        console.error('Save edit button not found');
    }
});

function setSchedule() {
    const baseUrl = document.getElementById('baseUrl').value;
    const locales = document.getElementById('locales').value.split(',').map(l => l.trim());
    const cronExpression = document.getElementById('cronExpression').value;

    fetch('/api/set-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cronExpression, testConfig: { baseUrl, locales } })
    })
    .then(response => response.json())
    .then(data => {
        console.log(data.message);
        loadSchedules();
    })
    .catch(error => console.error('Error:', error));
}

function loadSchedules() {
    fetch('/api/schedules')
        .then(response => response.json())
        .then(schedules => {
            const tbody = document.querySelector('#scheduleTable tbody');
            tbody.innerHTML = '';
            schedules.forEach(schedule => {
                const row = `
                    <tr>
                        <td>${schedule.baseUrl}</td>
                        <td>${schedule.locales.join(', ')}</td>
                        <td>${schedule.cronExpression}</td>
                        <td>${schedule.runCount}</td>
                        <td>${schedule.lastRun ? new Date(schedule.lastRun).toLocaleString() : 'N/A'}</td>
                        <td>${schedule.is_paused ? 'Paused' : 'Active'}</td>
                        <td>
                            <button class="btn btn-sm btn-primary edit-btn" data-id="${schedule.id}">Edit</button>
                            ${schedule.is_paused 
                                ? `<button class="btn btn-sm btn-success resume-btn" data-id="${schedule.id}">Resume</button>`
                                : `<button class="btn btn-sm btn-warning pause-btn" data-id="${schedule.id}">Pause</button>`
                            }
                            <button class="btn btn-sm btn-danger delete-btn" data-id="${schedule.id}">Delete</button>
                        </td>
                    </tr>
                `;
                tbody.insertAdjacentHTML('beforeend', row);
            });

            // Add event listeners to buttons
            tbody.querySelectorAll('.edit-btn').forEach(button => {
                button.addEventListener('click', function() {
                    const id = this.getAttribute('data-id');
                    const schedule = schedules.find(s => s.id == id);
                    if (schedule) {
                        openEditModal(schedule.id, schedule.baseUrl, schedule.locales, schedule.cronExpression);
                    }
                });
            });

            tbody.querySelectorAll('.pause-btn').forEach(button => {
                button.addEventListener('click', function() {
                    pauseSchedule(this.getAttribute('data-id'));
                });
            });

            tbody.querySelectorAll('.resume-btn').forEach(button => {
                button.addEventListener('click', function() {
                    resumeSchedule(this.getAttribute('data-id'));
                });
            });

            tbody.querySelectorAll('.delete-btn').forEach(button => {
                button.addEventListener('click', function() {
                    deleteSchedule(this.getAttribute('data-id'));
                });
            });
        })
        .catch(error => console.error('Error:', error));
}

function loadTestResults() {
    fetch('/api/test-results')
        .then(response => response.json())
        .then(results => {
            const tbody = document.querySelector('#resultTable tbody');
            tbody.innerHTML = '';
            results.forEach(result => {
                let resultPill;
                switch(result.result) {
                    case 'Pass':
                        resultPill = '<span class="result-pill result-pass">Pass</span>';
                        break;
                    case 'Fail':
                        resultPill = '<span class="result-pill result-fail">Fail</span>';
                        break;
                    case 'Null':
                    default:
                        resultPill = '<span class="result-pill result-null">Null</span>';
                        break;
                }
                const row = `
                    <tr>
                        <td>${new Date(result.test_date).toLocaleString()}</td>
                        <td>${result.url}</td>
                        <td>${resultPill}</td>
                        <td>${result.status}</td>
                        <td>${result.diff_percentage ? result.diff_percentage.toFixed(2) + '%' : 'N/A'}</td>
                        <td>
                            <button class="btn btn-sm btn-info view-images-btn" data-baseline="${result.baseline_image_path}" data-current="${result.current_image_path}" data-diff="${result.image_path}">View</button>
                        </td>
                    </tr>
                `;
                tbody.insertAdjacentHTML('beforeend', row);
            });

            // Add event listeners to view images buttons
            tbody.querySelectorAll('.view-images-btn').forEach(button => {
                button.addEventListener('click', function() {
                    const baseline = this.getAttribute('data-baseline');
                    const current = this.getAttribute('data-current');
                    const diff = this.getAttribute('data-diff');
                    showImages(baseline, current, diff);
                });
            });
        })
        .catch(error => console.error('Error:', error));
}


function showImages(baseline, current, diff) {
    const imageContainer = document.querySelector('#imageModal .image-container');
    imageContainer.innerHTML = `
        <div class="row">
            <div class="col-md-4">
                <h6>Baseline</h6>
                <img src="/images/${baseline}" class="img-fluid" onclick="showLargeImage('/images/${baseline}')">
            </div>
            <div class="col-md-4">
                <h6>Current</h6>
                <img src="/images/${current}" class="img-fluid" onclick="showLargeImage('/images/${current}')">
            </div>
            <div class="col-md-4">
                <h6>Diff</h6>
                <img src="/images/${diff}" class="img-fluid" onclick="showLargeImage('/images/${diff}')">
            </div>
        </div>
    `;
    new bootstrap.Modal(document.getElementById('imageModal')).show();
}

function showLargeImage(src) {
    document.getElementById('largeImage').src = src;
    new bootstrap.Modal(document.getElementById('largeImageModal')).show();
}

function pauseSchedule(id) {
    fetch(`/api/pause-schedule/${id}`, { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            console.log(data.message);
            loadSchedules(); // Reload schedules to update UI
        })
        .catch(error => console.error('Error:', error));
}


function resumeSchedule(id) {
    fetch(`/api/resume-schedule/${id}`, { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            console.log(data.message);
            loadSchedules(); // Reload schedules to update UI
        })
        .catch(error => console.error('Error:', error));
}

function deleteSchedule(id) {
    if (confirm('Are you sure you want to delete this schedule?')) {
        fetch(`/api/schedule/${id}`, { method: 'DELETE' })
            .then(response => response.json())
            .then(data => {
                console.log(data.message);
                loadSchedules();
            })
            .catch(error => console.error('Error:', error));
    }
}

function openEditModal(id, baseUrl, locales, cronExpression) {
    console.log('openEditModal called with:', { id, baseUrl, locales, cronExpression });
    
    const editScheduleId = document.getElementById('editScheduleId');
    const editBaseUrl = document.getElementById('editBaseUrl');
    const editLocales = document.getElementById('editLocales');
    const editCronExpression = document.getElementById('editCronExpression');
    
    if (!editScheduleId || !editBaseUrl || !editLocales || !editCronExpression) {
        console.error('One or more edit form elements not found');
        return;
    }
    
    editScheduleId.value = id;
    editBaseUrl.value = baseUrl;
    editLocales.value = Array.isArray(locales) ? locales.join(', ') : locales;
    editCronExpression.value = cronExpression;
    
    const modal = document.getElementById('editScheduleModal');
    if (!modal) {
        console.error('Edit schedule modal not found');
        return;
    }
    
    const bootstrapModal = new bootstrap.Modal(modal);
    bootstrapModal.show();
}

function updateVisualization(days) {
    fetch(`/api/visualization-data?days=${days}`)
        .then(response => response.json())
        .then(data => {
            createTimelines(data);
        })
        .catch(error => console.error('Error:', error));
}


function createTimelines(data) {
    const container = document.getElementById('timelineCharts');
    container.innerHTML = ''; // Clear existing charts

    // Loop through the data for each test and create a chart
    Object.entries(data).forEach(([testId, testData]) => {
        if (!Array.isArray(testData.dates) || !Array.isArray(testData.passRates) || !Array.isArray(testData.avgDiffPercentages)) {
            console.error(`Invalid data format for test ID ${testId}`, testData);
            return;  // Skip this entry if the data format is invalid
        }
    
        const canvasWrapper = document.createElement('div');
        canvasWrapper.className = 'mb-4';
        const canvas = document.createElement('canvas');
        canvas.id = `chart-${testId}`;
        canvasWrapper.appendChild(canvas);
        container.appendChild(canvasWrapper);
    
        const ctx = canvas.getContext('2d');
    
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: testData.dates,  // X-axis (dates)
                datasets: [
                    {
                        label: 'Pass Rate (%)',
                        data: testData.passRates,  // Y-axis for pass rates
                        borderColor: 'rgba(75, 192, 192, 1)',
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                        yAxisID: 'y-axis-1'
                    },
                    {
                        label: 'Avg Diff (%)',
                        data: testData.avgDiffPercentages,  // Y-axis for avg diff
                        borderColor: 'rgba(255, 206, 86, 1)',
                        backgroundColor: 'rgba(255, 206, 86, 0.2)',
                        yAxisID: 'y-axis-2'
                    }
                ]
            },
            options: {
                responsive: true,
                scales: {
                    x: {
                        type: 'time',  // Adjust time axis formatting if necessary
                        time: {
                            unit: 'day'
                        }
                    },
                    'y-axis-1': {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'Pass Rate (%)'
                        },
                        min: 0,
                        max: 100
                    },
                    'y-axis-2': {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Avg Diff (%)'
                        },
                        min: 0,
                        grid: {
                            drawOnChartArea: false
                        }
                    }
                }
            }
        });
    });
    
}


function saveEditSchedule() {
    const id = document.getElementById('editScheduleId').value;
    const baseUrl = document.getElementById('editBaseUrl').value;
    const locales = document.getElementById('editLocales').value.split(',').map(l => l.trim());
    const cronExpression = document.getElementById('editCronExpression').value;

    fetch(`/api/update-schedule/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cronExpression,
            testConfig: { baseUrl, locales }
        })
    })
    .then(response => response.json())
    .then(data => {
        console.log(data.message);
        loadSchedules();
        bootstrap.Modal.getInstance(document.getElementById('editScheduleModal')).hide();
    })
    .catch(error => console.error('Error:', error));
}