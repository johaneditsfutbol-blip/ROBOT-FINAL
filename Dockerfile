# Usamos una imagen ligera de Node 18
FROM node:18-slim

# 1. Instalar dependencias de Linux necesarias para correr Chrome/Puppeteer
# Esto es obligatorio en Railway, si no el robot dará error al intentar abrir el navegador
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. Configurar directorio de trabajo
WORKDIR /app

# 3. Copiar archivos de dependencias e instalar
COPY package*.json ./
RUN npm install

# 4. Copiar el resto del código (tu index.js)
COPY . .

# 5. Exponer el puerto (Railway usa su propia variable, pero esto es buena práctica)
EXPOSE 3000

# 6. Comando de arranque
CMD ["node", "index.js"]
