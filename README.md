# Flowpad

Create, connect, and collaborate with beautiful flow diagrams.

## Features

### 🎨 **Dark & Light Mode**
- Toggle between dark and light themes
- Persistent theme preference
- Smooth transitions between themes
- Consistent theming across all components

### 🧩 **Enhanced Tiles**
- Beautiful, modern tile design with rounded corners
- Resizable tiles with smooth animations
- Connection dots on all four sides (input, output, top, bottom)
- Hover effects and selection states
- Editable titles and content with auto-save

### 🔗 **Curved Connection Lines**
- SVG-based curved connections using quadratic Bézier curves
- Multiple connection types (input/output, top/bottom)
- Visual connection preview while dragging
- Arrow markers for direction
- Smooth animations and hover effects

### 🤖 **AI Suggestions**
- Integration with Magic Loop API for intelligent suggestions
- Context-aware recommendations based on existing tiles and connections
- One-click application of AI suggestions
- Real-time feedback and loading states

### 🛠️ **Enhanced Tools**
- Connection mode toggle (Select/Connect)
- Add new tiles with random positioning
- Delete selected tiles
- AI suggestions panel
- Improved toolbar with better UX

### 🔐 **Authentication & Sharing**
- Google OAuth integration
- Secure JWT-based authentication
- Graph sharing with other users
- Real-time collaboration ready

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp env.example .env
   # Edit .env with your database and Google OAuth credentials
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Open your browser:**
   Navigate to `http://localhost:3000`

## Usage

### Creating Connections
1. Click on a connection dot (colored circles on tile edges)
2. Drag to another tile's connection dot
3. Release to create a curved connection

### Using AI Suggestions
1. Select a tile
2. Click the 🤖 AI button
3. Describe what you want to add or connect
4. Click "Get Suggestions"
5. Click on a suggestion to apply it

### Theme Switching
- Click the theme toggle button (🌙/☀️) in the header
- Your preference is automatically saved

## API Endpoints

- `POST /api/ai-suggestions` - Get AI-powered suggestions for your flow diagrams
- `GET /api/graphs` - Retrieve user's graphs
- `POST /api/graphs` - Create new graph
- `PUT /api/graphs/:id` - Update existing graph
- `POST /api/graphs/:id/share` - Share graph with another user

## Technology Stack

- **Backend:** Node.js, Express.js, PostgreSQL
- **Frontend:** Vanilla JavaScript, CSS3, SVG
- **Authentication:** Google OAuth, JWT
- **AI Integration:** Magic Loop API
- **Styling:** CSS Custom Properties, CSS Grid, Flexbox

## Development

The application uses modern web technologies:
- CSS Custom Properties for theming
- SVG for scalable graphics
- CSS Grid for responsive layouts
- Modern JavaScript (ES6+) features

## License

© 2025 Flowpad. All rights reserved. 