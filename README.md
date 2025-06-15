# 🚀 Backend for Wavenet Solutions 📝

Welcome to the backend of Wavenet Solutions! This server powers all the real-time collaboration features, user authentication, and note management.

## ✨ Features

- **User Authentication** 🔐: Secure user registration and login using JWT.
- **Note Management** 🗒️: Create, read, update, delete, and share notes.
- **Real-time Collaboration** 🤝: Multiple users can edit the same note simultaneously with changes reflected live using Socket.io.
- **Note Archiving** 🗄️: Automatic archiving of old notes.
- **Rate Limiting** 🛡️: Protects the API from abuse.
- **Input Validation** ✅: Ensures data integrity using Joi.
- **Error Handling** ❌: Centralized error handling middleware.
- **Logging** 📜: Request logging with Morgan.
- **Security** 🔒: Basic security headers with Helmet.

## 🛠️ Tech Stack

- **Node.js**
- **Express.js**
- **TypeScript**
- **MongoDB** (with Mongoose)
- **Socket.IO**
- **JSON Web Tokens (JWT)**
- **bcrypt**
- **Joi**
- **Helmet**
- **Morgan**
- **Express Rate Limit**
- **Dotenv**
- **Nodemon** (for development)
- **ts-node** (for development)

## ⚙️ Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [MongoDB](https://www.mongodb.com/try/download/community) (ensure a MongoDB instance is running)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)

## 🚀 Getting Started

1.  **Clone the repository (if you haven't already):**

    ```bash
    git clone <repository-url>
    cd wavenet-solutions/backend
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Set up environment variables:**
    Create a `.env` file in the `backend` directory and add the following variables:

    ```env
    NODE_ENV=development
    PORT=5000 # Or any port you prefer
    MONGO_URI=your_mongodb_connection_string
    JWT_SECRET=your_jwt_secret_key
    FRONTEND_URL=http://localhost:3000 # URL of your frontend application
    COOKIE_SECRET=your_cookie_secret_key # For cookie parsing
    ```

    Replace `your_mongodb_connection_string` and `your_jwt_secret_key` with your actual MongoDB connection string and a strong secret key.

4.  **Run the development server:**
    ```bash
    npm run dev
    # or
    yarn dev
    ```
    The server will start on the port specified in your `.env` file (default is 5000). You should see a message like `Server running on port 5000` and `MongoDB Connected`.

## 📜 API Endpoints

- **Auth Routes (`/api/auth`)**:
  - `POST /register`: Register a new user.
  - `POST /login`: Log in an existing user.
  - `POST /logout`: Log out a user.
  - `GET /me`: Get the currently authenticated user's details.
- **Note Routes (`/api/notes`)**:
  - `POST /`: Create a new note.
  - `GET /`: Get all notes for the authenticated user.
  - `GET /:id`: Get a specific note by ID.
  - `PUT /:id`: Update a note by ID.
  - `DELETE /:id`: Delete a note by ID.
  - `POST /:id/share`: Share a note with another user.
  - `GET /search?q=<query>`: Search notes by title or content.
  - `POST /:id/archive`: Archive a note.
  - `GET /archived`: Get all archived notes for the user.
  - `POST /:id/unarchive`: Unarchive a note.
- **User Routes (`/api/users`)**:
  - `GET /search?q=<query>`: Search for users (e.g., for sharing notes).

## 🔌 Socket.IO Events

The backend uses Socket.IO for real-time communication. Key events include:

- `registerUser (userId)`: Client registers its socket with a user ID.
- `joinNoteRoom (noteId)`: Client joins a room specific to a note for real-time updates.
- `leaveNoteRoom (noteId)`: Client leaves a note room.
- `userStartedEditingNote ({ noteId, userId, username })`: Broadcasts when a user starts editing a note.
- `userStoppedEditingNote ({ noteId, userId, username })`: Broadcasts when a user stops editing a note.
- `userFinishedEditingNoteWithContent ({ noteId, title, content, editorId, editorUsername })`: Sent when a user finishes editing and saves the note content. The server then updates the database and broadcasts the changes.
- `noteUpdated ({ noteId, title, content, updatedBy, lastUpdatedAt })`: Server emits this to clients in the note room when a note is updated.
- `noteShared ({ noteId, sharedWithUsername, sharedByUsername })`: Server emits this to the user with whom the note was shared.
- `notification (message)`: Server emits general notifications to specific users.

## 🏗️ Project Structure

```
backend/
├── src/
│   ├── config/         # Environment variables and configurations
│   ├── controllers/    # Request handlers and business logic
│   ├── middleware/     # Express middleware (auth, error handling, etc.)
│   ├── models/         # Mongoose schemas and models
│   ├── routes/         # API route definitions
│   ├── services/       # Business logic services (e.g., archiving)
│   ├── types/          # TypeScript type definitions
│   ├── utils/          # Utility functions
│   └── server.ts       # Main server setup and Socket.IO logic
├── .env.example        # Example environment file
├── package.json
├── tsconfig.json
└── vercel.json         # Vercel deployment configuration (if applicable)
```

## 📦 Scripts

- `npm run dev`: Starts the server in development mode with Nodemon for auto-reloading.
- `npm run build`: Compiles TypeScript to JavaScript.
- `npm run start`: Starts the server from the compiled JavaScript (for production).
- `npm test`: (Currently a placeholder) Run tests.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue.

---

Happy Coding! 🎉
