FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create directories
RUN mkdir -p /app/.telemetry /app/.storage

# Expose port
EXPOSE 8001

# Run the admin dashboard
CMD ["python", "main.py"]
