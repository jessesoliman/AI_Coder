const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const session = require('express-session');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
app.use(cors({
    origin: 'http://localhost:3000', // Adjust this to match your frontend URL
    credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));


// Session management
// const MySQLStore = require('express-mysql-session')(session);

//const sessionStore = new MySQLStore({
//    host: '127.0.0.1',
//    user: 'root',
//    password: 'test',
//    database: 'quizapp'
//});

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60, // 1 hour
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        sameSite: 'lax' // This allows cookies to be sent across different origins
    }
}));

// Database connection
const db = mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'test',
    database: 'quizapp'
});

db.connect(err => {
    if (err) throw err;
    console.log('Connected to MySQL database');
});

// Function to generate a unique key
function generateUniqueKey() {
    return crypto.randomBytes(8).toString('hex');
}

// Middleware to check if the user is authenticated
function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    } else {
        return res.status(401).json({ error: 'Unauthorized' });
    }
}

// Route to create a new quiz (only for authenticated employers)
// Create a new quiz and send email with the unique link
app.post('/create-quiz', isAuthenticated, async (req, res) => {
    const { title, description, timeLimit, questions, candidateEmail } = req.body;
    const employerId = req.session.userId;
    const uniqueKey = crypto.randomBytes(8).toString('hex');
    const quizLink = `http://localhost:3000/take-quiz/${uniqueKey}`;

    // Insert the quiz into the database
    const insertQuizQuery = `INSERT INTO quizzes (title, description, time_limit, unique_key, employer_id) VALUES (?, ?, ?, ?, ?)`;
    db.query(insertQuizQuery, [title, description, timeLimit, uniqueKey, employerId], (err, result) => {
        if (err) {
            console.error('Failed to insert quiz:', err);
            return res.status(500).json({ error: 'Failed to create quiz' });
        }

        const quizId = result.insertId;

        // Insert the questions into the database
        const questionPromises = questions.map((question, index) => {
            return new Promise((resolve, reject) => {
                const insertQuestionQuery = `INSERT INTO questions (quiz_id, question_text, question_type) VALUES (?, ?, ?)`;
                db.query(insertQuestionQuery, [quizId, question.text, question.type], (err, questionResult) => {
                    if (err) {
                        console.error('Failed to insert question:', err);
                        return reject(err);
                    }

                    const questionId = questionResult.insertId;

                    // Insert the options for each question if applicable
                    if (question.options && question.options.length > 0) {
                        const optionPromises = question.options.map((option, optionIndex) => {
                            return new Promise((resolveOption, rejectOption) => {
                                const isCorrect = question.correctAnswers.includes(option) ? 1 : 0;
                                const insertOptionQuery = `INSERT INTO answer_options (question_id, option_text, is_correct) VALUES (?, ?, ?)`;
                                db.query(insertOptionQuery, [questionId, option, isCorrect], (err) => {
                                    if (err) {
                                        console.error('Failed to insert option:', err);
                                        return rejectOption(err);
                                    }
                                    resolveOption();
                                });
                            });
                        });

                        Promise.all(optionPromises).then(resolve).catch(reject);
                    } else {
                        resolve();
                    }
                });
            });
        });

        Promise.all(questionPromises)
            .then(async () => {
                // Send the email with the quiz link
                if (candidateEmail) {
                    const subject = `Invitation to Take a Quiz: ${title}`;
                    const text = `You have been invited to take a quiz. Please use the following link to access it:\n\n${quizLink}\n\nGood luck!`;
                    await sendEmail(candidateEmail, subject, text);
                }
                res.json({ message: 'Quiz created successfully', link: quizLink });
            })
            .catch((err) => {
                console.error('Failed to insert questions:', err);
                res.status(500).json({ error: 'Failed to insert questions' });
            });
    });
});

////////////////// QUIZ MANAGEMENT ROUTES (quiz CRUD) ////////////////

// Fetch all quizzes for the logged-in employer
app.get('/quizzes', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const query = `SELECT id, title, description, time_limit, created_at FROM quizzes WHERE employer_id = ?`;
    db.query(query, [req.session.userId], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// Delete a specific quiz
app.delete('/quiz/:id', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const quizId = req.params.id;
    const deleteQuery = `DELETE FROM quizzes WHERE id = ? AND employer_id = ?`;

    db.query(deleteQuery, [quizId, req.session.userId], (err, result) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to delete quiz' });
        }
        res.json({ message: 'Quiz deleted successfully' });
    });
});

// Fetch details of a specific quiz for editing
app.get('/quiz/:id', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const quizId = req.params.id;
    const query = `SELECT * FROM quizzes WHERE id = ? AND employer_id = ?`;

    db.query(query, [quizId, req.session.userId], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).json({ error: 'Quiz not found' });
        }
        res.json(results[0]);
    });
});

// Update a specific quiz
app.put('/quiz/:id', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const quizId = req.params.id;
    const { title, description, timeLimit } = req.body;

    const updateQuery = `UPDATE quizzes SET title = ?, description = ?, time_limit = ? WHERE id = ? AND employer_id = ?`;
    db.query(updateQuery, [title, description, timeLimit, quizId, req.session.userId], (err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to update quiz' });
        }
        res.json({ message: 'Quiz updated successfully' });
    });
});


////////////////// EMPLOYER MANAGEMENT ROUTES ////////////////

// Route to register a new employer
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;

    // Check if all fields are provided
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if the email is already registered
    const checkQuery = 'SELECT * FROM employers WHERE email = ?';
    db.query(checkQuery, [email], async (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (results.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        try {
            // Hash the password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Insert the new employer into the database
            const insertQuery = 'INSERT INTO employers (name, email, password) VALUES (?, ?, ?)';
            db.query(insertQuery, [name, email, hashedPassword], (err, result) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }
                res.status(201).json({ message: 'Employer registered successfully' });
            });
        } catch (error) {
            res.status(500).json({ error: 'Error registering employer' });
        }
    });
});

// Route to check if a user is authenticated and return profile information
app.get('/check-auth', (req, res) => {
    if (req.session && req.session.userId) {
        const query = `SELECT name, email FROM employers WHERE id = ?`;
        db.query(query, [req.session.userId], (err, results) => {
            if (err || results.length === 0) {
                return res.status(500).json({ error: 'Failed to fetch profile data' });
            }
            const { name, email } = results[0];
            res.status(200).json({ name, email });
        });
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    

    const query = `SELECT * FROM employers WHERE email = ?`;
    db.query(query, [email], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const match = await bcrypt.compare(password, results[0].password);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Set the session
        req.session.userId = results[0].id;
        req.session.save((err) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to save session' });
            }
            console.log("Session saved:", req.session);
            res.json({ message: 'Logged in successfully' });
        });
    });
});

// Update Profile
app.post('/update-profile', (req, res) => {
    const { name } = req.body;
    const userId = req.session.userId;
    const query = `UPDATE employers SET name = ? WHERE id = ?`;

    db.query(query, [name, userId], (err) => {
        if (err) return res.status(500).json({ error: 'Update failed' });
        res.json({ message: 'Profile updated' });
    });
});

// Logout
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logged out' });
});

////////////////// EMAIL CONFIGURATION ROUTES ////////////////

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
    service: 'gmail', // Use your email service provider (e.g., Gmail, Outlook)
    auth: {
        user: 'jessesoliman@gmail.com', // Replace with your email
        pass: 'jdmqdfnjoqmhwegu'   // Replace with your email password or app password
    }
});

// Function to send email
async function sendEmail(to, subject, text) {
    try {
        await transporter.sendMail({
            from: 'jessesoliman@gmail.com',
            to,
            subject,
            text
        });
        console.log('Email sent successfully to', to);
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});