# coc-tslint

Tslint language server extension for [coc.nvim](https://github.com/neoclide/coc.nvim).

The `tslint` module is resolved from current file and then global modules of `npm` and `yarn`.

## Install

Install [nodejs](https://nodejs.org/en/download/) and [yarn](https://yarnpkg.com/en/docs/install).

``` sh
curl -sL install-node.now.sh/lts | sh
curl --compressed -o- -L https://yarnpkg.com/install.sh | bash
```

For [vim-plug](https://github.com/junegunn/vim-plug) user. Add:

``` vim
Plug 'neoclide/coc.nvim', {'do': { -> coc#util#install()}}
Plug 'neoclide/coc-tslint', {'do': 'yarn install --production'}
```

to your `.vimrc` or `init.vim`, restart vim and run `:PlugInstall`.

## Features

* Lint `typescript` and `javascript` files using tslint.
* Provide `codeActions` for fix lint issues.
* Provide tslint commands:
  * `tslint.fixAllProblems` fix problems of current buffer.
  * `tslint.createConfig` create tslint config file.
  * `tslint.lintProject` lint current project

## License

MIT
