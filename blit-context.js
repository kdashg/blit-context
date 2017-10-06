(function() {
    'use strict';

    function scaleRect(rect, scaleX, scaleY) {
        rect[0] *= scaleX;
        rect[1] *= scaleY;
        rect[2] *= scaleX;
        rect[3] *= scaleY;
    }

    function flipY(rect, height) {
        rect[1] = height - (rect[1] + rect[3]);
    }

    function normalizeCanvasRect(rect, gl) {
        scaleRect(rect, 1.0 / gl.canvas.width, 1.0 / gl.canvas.height);
        flipY(rect, 1.0);
    }

    function linkProgramSources(gl, vertSource, fragSource) {
        const prog = gl.createProgram();

        function attachShaderSource(type, glsl) {
            glsl = glsl.trim() + '\n';

            const shader = gl.createShader(type);
            gl.shaderSource(shader, glsl);
            gl.compileShader(shader);
            gl.attachShader(prog, shader);
            return shader;
        }
        const vs = attachShaderSource(gl.VERTEX_SHADER, vertSource);
        const fs = attachShaderSource(gl.FRAGMENT_SHADER, fragSource);

        gl.linkProgram(prog);

        const success = gl.getProgramParameter(prog, gl.LINK_STATUS);
        if (!success) {
            console.log('Error linking program: ' + gl.getProgramInfoLog(prog));
            console.log('\nVert shader log: ' + gl.getShaderInfoLog(vs));
            console.log('\nFrag shader log: ' + gl.getShaderInfoLog(fs));
            return null;
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        let count = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveAttrib(prog, i);
            prog[info.name] = gl.getAttribLocation(prog, info.name);
        }
        count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(prog, i);
            prog[info.name] = gl.getUniformLocation(prog, info.name);
        }
        return prog;
    }

    const kBlitVS = [
        'attribute vec2 aVert;',
        'uniform vec4 uDestRect;',
        'uniform vec4 uTexRect;',
        'varying vec2 vTexCoord;',
        '',
        'void main() {',
        '    vec2 destPos = uDestRect.xy + aVert*uDestRect.zw;',
        '    gl_Position = vec4(destPos * 2.0 - 1.0, 0.0, 1.0);',
        '    vTexCoord = uTexRect.xy + aVert*uTexRect.zw;',
        '}',
    ].join('\n');
    const kBlitFS = [
        'precision mediump float;',
        '',
        'uniform sampler2D uTex;',
        'varying vec2 vTexCoord;',
        '',
        'void main() {',
        '    gl_FragColor = texture2D(uTex, vTexCoord);',
        '}',
    ].join('\n');

    window.BlitRenderingContext = function(gl) {
        this.gl = gl;

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // Make DOM uploads origin-bottom-left.
        const attribs = gl.getContextAttributes();
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.premultiplyAlpha);

        const vertData = [
            0, 0,
            1, 0,
            0, 1,
            1, 1,
        ];

        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertData), gl.STATIC_DRAW);

        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        this.blitProg = linkProgramSources(gl, kBlitVS, kBlitFS);
        gl.useProgram(this.blitProg);
        gl.uniform1i(this.blitProg.uTex, 0);

        this.defaultTex = this.createTexture();
    };

    window.BlitRenderingContext.prototype.blit = function(src, srcRect, destOffset,
                                                          destSize)
    {
        const gl = this.gl;

        let tex;
        if (src instanceof window.BlitTexture) {
            tex = src;
        } else {
            tex = this.defaultTex;
            tex.snapshot(src);
        }

        gl.bindTexture(gl.TEXTURE_2D, tex.tex);

        srcRect = srcRect || [0, 0, tex.width, tex.height];
        destOffset = destOffset || [0, 0];
        destSize = destSize || [srcRect[2], srcRect[3]];
        const destRect = [destOffset[0], destOffset[1], destSize[0], destSize[1]];

        scaleRect(srcRect, 1.0 / tex.width, 1.0 / tex.height);
        flipY(srcRect, 1.0);

        normalizeCanvasRect(destRect, gl);

        if (gl.drawingBufferWidth != this.lastWidth ||
            gl.drawingBufferHeight != this.lastHeight)
        {
            this.lastWidth = gl.drawingBufferWidth;
            this.lastHeight = gl.drawingBufferHeight;
            gl.viewport(0, 0, this.lastWidth, this.lastHeight);
        }
        gl.uniform4f(this.blitProg.uDestRect, destRect[0], destRect[1], destRect[2], destRect[3]);
        gl.uniform4f(this.blitProg.uTexRect, srcRect[0], srcRect[1], srcRect[2], srcRect[3]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    window.BlitRenderingContext.prototype.clear = function(r,g,b,a, destRect) {
        a = a || 1.0;
        const gl = this.gl;
        gl.clearColor(r,g,b,a);
        if (destRect) {
            gl.enable(gl.SCISSOR_TEST);
            normalizeCanvasRect(destRect, gl);
            scaleRect(destRect, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.scissor(destRect[0], destRect[1], destRect[2], destRect[3]);
        }
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (destRect) {
            gl.disable(gl.SCISSOR_TEST);
        }
    };

    window.BlitRenderingContext.prototype.createTexture = function() {
        const gl = this.gl;
        const tex = new window.BlitTexture(this);
        return tex;
    };

    Object.defineProperty(window.BlitRenderingContext.prototype, 'canvas', {
        get: function () { return this.gl.canvas; },
    });

    window.BlitTexture = function(brc) {
        this.brc = brc;
        const gl = this.brc.gl;
        this.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.width = 0;
        this.height = 0;
    };
    window.BlitTexture.prototype.delete = function() {
        const gl = this.brc.gl;
        gl.deleteTexture(this.tex);
    };
    window.BlitTexture.prototype.snapshot = function(src) {
        const gl = this.brc.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        this.width = src.width;
        this.height = src.height;
    };

    const fnGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, attribs) {
        if (type !== 'blit')
            return fnGetContext.apply(this, [type, attribs]);

        attribs = attribs || {};
        attribs.premultiplyAlpha = attribs.premultiplyAlpha || true;
        attribs.antialias = attribs.antialias || false;
        attribs.depth = attribs.depth || false;
        const gl = fnGetContext.apply(this, ['experimental-webgl', attribs]);
        if (!gl || gl.brc)
            return null;

        gl.brc = new BlitRenderingContext(gl);
        return gl.brc;
    }
})();
