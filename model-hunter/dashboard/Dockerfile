FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create telemetry directory
RUN mkdir -p /app/.telemetry

# Expose port
EXPOSE 8001

# Run the dashboard
CMD ["python", "main.py"]
