# 1. Usamos la imagen OFICIAL de Puppeteer.
# Ya trae Chrome instalado, optimizado y con las fuentes necesarias.
# Esto reduce el tiempo de build de 20 minutos a 2 minutos.
FROM ghcr.io/puppeteer/puppeteer:21.0.0

# 2. Configuración CRÍTICA de Entorno
# - Saltamos la descarga de Chromium (ya lo tenemos).
# - Apuntamos al Chrome real.
# - FORZAMOS LA HORA DE VENEZUELA (Esto arregla el rechazo de Icaro).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    TZ=America/Caracas

# 3. Volvemos a root para configurar permisos
USER root

WORKDIR /usr/src/app

# 4. Copiamos archivos
COPY package*.json ./

# 5. Instalamos dependencias ligeras (Express, etc)
RUN npm install

COPY . .

# 6. Permisos para el usuario de seguridad de Google
RUN chown -R pptruser:pptruser /usr/src/app

# 7. Volvemos al usuario seguro
USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]
