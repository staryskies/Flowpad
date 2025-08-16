# Flowpad - Flow Diagram Creator

A modern, collaborative flow diagram creator with draggable tiles, unlimited connections, and real-time sharing capabilities.

## Features

- **Draggable Tiles**: Create and move tiles with connection dots on all sides
- **Unlimited Connections**: Connect tiles with beautiful curved lines
- **Real-time Collaboration**: Share graphs with others via email
- **Google Authentication**: Secure sign-in using Google OAuth
- **Grid Background**: Visual grid to help with positioning
- **Auto-resizing Text**: Text areas automatically resize to content
- **Modern UI**: Beautiful black and white design with glassmorphism effects
- **PostgreSQL Backend**: Persistent storage with sharing capabilities
- **Vercel Ready**: Optimized for deployment on Vercel

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL
- **Authentication**: Google OAuth 2.0
- **Deployment**: Vercel

## Setup Instructions

### Prerequisites

- Node.js 18+ installed
- PostgreSQL database
- Google OAuth 2.0 credentials

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd Flowpad
npm install
```

### 2. Environment Variables

Create a `.env` file in the root directory:

```env
JWT_SECRET=your-super-secret-jwt-key-here
DATABASE_URL=postgresql://flowpad_user:MAOwGkTa8Et6OqgPGgiv8VLrBFX1vBqE@dpg-d2gb69vdiees73dauq4g-a/flowpad
GOOGLE_CLIENT_ID=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
```

### 3. Database Setup

The application will automatically create the necessary tables on first run:

- `users` - User accounts and authentication
- `graphs` - Flow diagrams and their data
- `graph_shares` - Graph sharing permissions

### 4. Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add your domain to authorized origins
6. Update the `GOOGLE_CLIENT_ID` in your environment variables

### 5. Run Locally

```bash
npm start
```

The application will be available at `http://localhost:3000`

### 6. Deploy to Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. Run: `vercel`
3. Follow the prompts to deploy

## Usage

### Creating a New Graph

1. Sign in with Google
2. Click "New Graph" button
3. Enter a title for your graph
4. Start adding tiles and connections

### Adding Tiles

1. Click the "+" button in the toolbar
2. Drag tiles to position them
3. Edit titles and content by clicking on the text areas
4. Text automatically resizes to fit content

### Creating Connections

1. Click and drag from a connection dot (green dots on tile edges)
2. Drag to another tile's connection dot
3. Release to create a curved connection
4. Connections are automatically saved

### Sharing Graphs

1. Select a graph from your dashboard
2. Enter the email address of the person you want to share with
3. Click "Share"
4. The recipient will see the graph in their "Shared With Me" section

### Keyboard Shortcuts

- **Delete**: Remove selected tile
- **Ctrl+D**: Duplicate selected tile
- **G**: Toggle grid visibility

## File Structure

```
Flowpad/
├── server.js          # Express server with API endpoints
├── index.html         # Sign-in page with Google authentication
├── graph.html         # Main dashboard and flow diagram editor
├── package.json       # Dependencies and scripts
├── vercel.json        # Vercel deployment configuration
└── README.md          # This file
```

## API Endpoints

- `POST /api/auth/google` - Google OAuth authentication
- `GET /api/graphs` - Get user's graphs (own + shared)
- `POST /api/graphs` - Create new graph
- `PUT /api/graphs/:id` - Update existing graph
- `GET /api/graphs/:id` - Get specific graph
- `POST /api/graphs/:id/share` - Share graph with email

## Customization

### Styling

The application uses CSS custom properties for easy theming. Main colors can be modified in the CSS variables:

```css
:root {
  --primary-color: #4CAF50;
  --background-color: #1a1a1a;
  --text-color: #ffffff;
}
```

### Adding New Tile Types

To add new tile types, modify the `createTile()` function in `graph.html` and add corresponding CSS styles.

## Troubleshooting

### Common Issues

1. **Google Sign-in not working**: Check your Google OAuth credentials and authorized origins
2. **Database connection failed**: Verify your PostgreSQL connection string and SSL settings
3. **Graphs not saving**: Check your JWT_SECRET environment variable
4. **Sharing not working**: Ensure the recipient has a valid email address

### Logs

Check the server console for detailed error messages and database connection status.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions, please open an issue in the GitHub repository. 