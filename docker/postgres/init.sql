-- Voice MCP Gateway Database Initialization
-- Creates tables for user management, sessions, and audit logging

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE
);

-- User permissions table
CREATE TABLE IF NOT EXISTS user_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mcp_tool VARCHAR(100) NOT NULL,
    risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
    granted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    granted_by UUID REFERENCES users(id),
    UNIQUE(user_id, mcp_tool)
);

-- Voice sessions table
CREATE TABLE IF NOT EXISTS voice_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT
);

-- Voice commands audit log
CREATE TABLE IF NOT EXISTS voice_commands_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    command_text TEXT NOT NULL,
    confidence DECIMAL(3,2),
    mcp_tool VARCHAR(100),
    mcp_params JSONB,
    success BOOLEAN NOT NULL,
    latency_ms INTEGER,
    error_message TEXT,
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- MCP server connections
CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    command VARCHAR(255) NOT NULL,
    args JSONB,
    transport VARCHAR(20) NOT NULL CHECK (transport IN ('stdio', 'sse', 'websocket')),
    timeout_ms INTEGER DEFAULT 5000,
    is_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Performance metrics
CREATE TABLE IF NOT EXISTS performance_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES voice_sessions(id) ON DELETE CASCADE,
    operation VARCHAR(50) NOT NULL,
    duration_ms INTEGER NOT NULL,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    metadata JSONB,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_id ON voice_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_active ON voice_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_voice_commands_log_session_id ON voice_commands_log(session_id);
CREATE INDEX IF NOT EXISTS idx_voice_commands_log_user_id ON voice_commands_log(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_commands_log_executed_at ON voice_commands_log(executed_at);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_session_id ON performance_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_operation ON performance_metrics(operation);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_recorded_at ON performance_metrics(recorded_at);

-- Insert default MCP server (Desktop Commander)
INSERT INTO mcp_servers (name, command, args, transport, timeout_ms, is_enabled)
VALUES (
    'Desktop Commander',
    'npx',
    '["-y", "@wonderwhy-er/desktop-commander"]'::jsonb,
    'stdio',
    10000,
    true
) ON CONFLICT (name) DO NOTHING;

-- Create default admin user (password: admin123)
-- In production, this should be changed immediately
INSERT INTO users (email, password_hash, is_admin)
VALUES (
    'admin@voicemcp.local',
    '$2b$10$8K1p/a0dXhwC5k6yB9ZfDe6R1zQ5Nq7K9rY3m2pL5x8v4w1a6c3f9b',
    true
) ON CONFLICT (email) DO NOTHING;

-- Grant default permissions to admin user
INSERT INTO user_permissions (user_id, mcp_tool, risk_level, granted_by)
SELECT
    u.id,
    tool.tool_name,
    tool.risk_level,
    u.id
FROM users u
CROSS JOIN (
    VALUES
        ('read_file', 'low'),
        ('list_directory', 'low'),
        ('get_config', 'low'),
        ('list_processes', 'low'),
        ('create_directory', 'medium'),
        ('write_file', 'medium'),
        ('start_process', 'medium'),
        ('kill_process', 'high'),
        ('move_file', 'high'),
        ('set_config_value', 'high')
) AS tool(tool_name, risk_level)
WHERE u.email = 'admin@voicemcp.local'
ON CONFLICT (user_id, mcp_tool) DO NOTHING;

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_mcp_servers_updated_at BEFORE UPDATE ON mcp_servers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();