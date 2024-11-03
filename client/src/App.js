import React, { useState } from 'react';
import { ForceGraph2D } from 'react-force-graph';
import axios from 'axios';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

function App() {
  const [url, setUrl] = useState('');
  const [k, setK] = useState(2);
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleReset = () => {
    setGraphData({ nodes: [], links: [] });
    setError(null);
    // Update API URL
    axios.post(`${API_URL}/api/reset`).catch(console.error);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      console.log('Sending request to:', `${API_URL}/api/crawl`);
      const response = await axios.post(`${API_URL}/api/crawl`, {
        url,
        k,
        reset: false
      });
      
      console.log('Received response:', response.data);
      
      if (!response.data.nodes || !response.data.links) {
        throw new Error('Invalid response format from server');
      }

      // Create maps of existing nodes and links
      const existingNodes = new Map(graphData.nodes.map(node => [node.id, node]));
      const existingLinks = new Set(graphData.links.map(link => 
        `${link.source.id || link.source}-${link.target.id || link.target}`
      ));

      // Process new nodes
      response.data.nodes.forEach(node => {
        if (!existingNodes.has(node.id)) {
          existingNodes.set(node.id, {
            ...node,
            x: undefined,
            y: undefined,
            vx: undefined,
            vy: undefined
          });
        }
      });

      // Process new links
      const newLinks = response.data.links
        .filter(link => {
          const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
          const targetId = typeof link.target === 'object' ? link.target.id : link.target;
          if (!sourceId || !targetId) {
            console.warn('Invalid link:', link);
            return false;
          }
          return existingNodes.has(sourceId) && existingNodes.has(targetId);
        })
        .map(link => ({
          source: existingNodes.get(typeof link.source === 'object' ? link.source.id : link.source),
          target: existingNodes.get(typeof link.target === 'object' ? link.target.id : link.target)
        }))
        .filter(link => {
          const linkId = `${link.source.id}-${link.target.id}`;
          return !existingLinks.has(linkId);
        });

      const updatedGraphData = {
        nodes: Array.from(existingNodes.values()),
        links: [...graphData.links, ...newLinks]
      };
      
      console.log('Setting graph data:', updatedGraphData);
      setGraphData(updatedGraphData);
      setUrl('');
    } catch (error) {
      console.error('Error fetching graph data:', error);
      setError(error.response?.data?.error || error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="App">
      <div className="controls">
        <form onSubmit={handleSubmit}>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter URL to crawl (e.g., https://example.com)"
            required
          />
          <input
            type="number"
            value={k}
            onChange={(e) => setK(parseInt(e.target.value))}
            min="1"
            max="3"
            placeholder="Depth (1-3)"
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Crawling...' : 'Add to Graph'}
          </button>
          <button 
            type="button" 
            onClick={handleReset}
            disabled={loading || graphData.nodes.length === 0}
          >
            Reset Graph
          </button>
        </form>
        {error && <div className="error">{error}</div>}
        <div className="stats">
          Nodes: {graphData.nodes.length} | Links: {graphData.links.length}
        </div>
      </div>

      <div className="graph-container">
        {graphData.nodes.length > 0 ? (
          <ForceGraph2D
            graphData={graphData}
            nodeLabel={node => node.title || node.id}
            nodeRelSize={4}
            linkDirectionalParticles={2}
            linkDirectionalParticleSpeed={0.005}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const size = 16/globalScale;
              const x = node.x || 0;
              const y = node.y || 0;
              
              if (node.favicon) {
                const image = new Image();
                image.src = node.favicon;
                image.onerror = () => {
                  // Draw fallback circle if favicon fails to load
                  ctx.beginPath();
                  ctx.arc(x, y, size/3, 0, 2 * Math.PI, false);
                  ctx.fillStyle = '#999';
                  ctx.fill();
                  ctx.strokeStyle = '#666';
                  ctx.stroke();
                };
                ctx.drawImage(image, x - size/2, y - size/2, size, size);
              } else {
                // Default node appearance - make it more visible
                ctx.beginPath();
                ctx.arc(x, y, size/2.5, 0, 2 * Math.PI, false);
                ctx.fillStyle = '#666';
                ctx.fill();
                ctx.strokeStyle = '#444';
                ctx.lineWidth = 1.5;
                ctx.stroke();
              }

              // Show label on hover
              if (node === graphData.__lastHovered) {
                const label = node.title || node.id;
                const fontSize = 12/globalScale;
                ctx.font = `${fontSize}px Sans-Serif`;
                const textWidth = ctx.measureText(label).width;
                const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                ctx.fillRect(
                  x - bckgDimensions[0] / 2,
                  y - bckgDimensions[1] / 2 - fontSize,
                  bckgDimensions[0],
                  bckgDimensions[1]
                );

                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#000';
                ctx.fillText(label, x, y - fontSize/2);
              }
            }}
            onNodeHover={node => {
              graphData.__lastHovered = node || null;
            }}
            onNodeClick={(node) => {
              window.open(node.id, '_blank');
            }}
          />
        ) : (
          <div className="no-data">
            {loading ? 'Loading graph...' : 'Enter a URL and click Add to Graph'}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
